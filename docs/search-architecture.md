# Global Search — Architecture & Design (Stage 1)

Design-only. No production code, no schema changes, no PR. This document is
the sole deliverable of Stage 1, following the same staged-rollout discipline
the Notifications Center and Comments & Mentions features already proved out
in this codebase.

## 0. Grounding: what already exists

Everything below was read directly from the current codebase before any
decision in this document was made.

### 0.1 The data this feature searches

`prisma/schema.prisma` (792 lines, read in full) defines every in-scope
entity:

- `Client` — `name`, `email`, `phone`, `company`, `notes`; `organizationId`
  (nullable, `onDelete: SetNull`); no soft delete.
- `Project` — `name`, `description`; `clientId` (`onDelete: Cascade`),
  `ownerId`, `organizationId` (nullable, `SetNull`); no soft delete.
- `Task` — `title`, `description`; `projectId` (`onDelete: Cascade`),
  `organizationId` (nullable, `SetNull`); no soft delete.
- `Invoice` — `invoiceNumber`; `clientId`, `projectId` (both `onDelete:
  Restrict`), `organizationId` (nullable, `SetNull`); no soft delete.
- `Comment` — `body` (plain text only, mention tokens as literal
  `@[Name](user:uuid)` substrings); `organizationId` (`onDelete: Cascade`),
  `entityType` (`PROJECT`/`TASK`), `entityId` (not a FK — app-layer ownership
  check, same as `Activity`/`Attachment`); `deletedAt` — **the only in-scope
  model with soft delete**.

Confirmed by grep: `deletedAt` appears exactly once in the whole schema, on
`Comment`. Client/Project/Task/Invoice are hard-deleted; there is no
"excluded but present" row to filter for them, only for Comments.

### 0.2 The permission model search inherits

`src/lib/current-user.ts` — `getCurrentUserOrganization()` and
`getCurrentMembership()` are the two primitives every existing org-scoped
read already uses. Critically, `resolveActiveOrganizationId()`'s own doc
comment states it "only ever returns an organizationId backed by an existing
Membership row" — calling it **is** the authorization check, not a
precursor to one. Every list query in this app (`buildClientWhere`,
`buildProjectWhere`, `buildTaskWhere`, `buildInvoiceWhere`, `getCommentsPage`)
takes `organizationId` as its first, non-optional parameter, sourced
exclusively from this helper, never from client input.

`getOrCreateUser()` (same file) already redirects a Client-Portal-only
identity (a `PortalUser` with no staff `Membership`) to `/portal` before an
organizationId is ever resolved for them — the same guard Comments & Mentions
relied on for its own portal exclusion, already verified correct against
production during that feature's Stage 6.

One finding with real weight for Search: **there is no row-level ACL beyond
org Membership**. `buildClientWhere(organizationId, ...)`,
`buildProjectWhere`, `buildTaskWhere`, `buildInvoiceWhere` (all in their
respective `app/(dashboard)/*/query.ts`) scope by `organizationId` alone —
any `OWNER`/`ADMIN`/`MEMBER` sees every Client/Project/Task/Invoice in their
org. `getCommentsPage` (`src/lib/comments/queries.ts`) has no author-based
filter either — every org member reads every comment. Role only gates
*mutations* (Comment edit is author-only, delete is author-or-moderator,
per `docs/comments-architecture.md` §4) — never *visibility*. Search
inherits exactly this: "member of the org" is the entire visibility rule,
for every in-scope entity.

### 0.3 Existing search/filter — and why it isn't this feature

Every list page already has a `q` parameter:

```ts
// src/app/(dashboard)/clients/query.ts
export function buildClientWhere(organizationId: string, { q, status }) {
  return {
    organizationId,
    ...(status ? { status } : {}),
    ...(q ? { OR: [
      { name: { contains: q, mode: "insensitive" } },
      { company: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
    ] } : {}),
  };
}
```

The same shape repeats in `projects/query.ts` (also matching
`client.name`), `tasks/query.ts` (also matching `project.name`), and
`invoices/query.ts` (also matching `project.name` and
`project.client.name`) — a simple `contains`/`insensitive` `OR` across a
handful of text columns, sometimes reaching one relation deep, with **no
supporting text index today**. This is submitted via `SearchFilterBar`
(`src/components/list/search-filter-bar.tsx`) — a plain `<form method="GET">`
with a "Search" submit button. It is a **full page reload**, per-list,
offset-paginated (`src/lib/list-params.ts`: `PAGE_SIZE = 10`,
`getOffset`/`getTotalPages`) filter — not live, not cross-entity, not
keyboard-driven. Global Search is additive to this, not a replacement: the
per-list filters keep working exactly as they do today.

### 0.4 Two existing pagination shapes, and where Search's own shape sits

- **Offset** (`src/lib/list-params.ts`) — Clients/Projects/Tasks/Invoices.
  Real "page 3 of 12" navigation.
- **Keyset/cursor** (`src/lib/activity/cursor.ts`:
  `encodeActivityCursor`/`decodeActivityCursor`, a base64url `{createdAt,
  id}` pair) — Activity, Notifications, Comments. `buildActivityWhere`'s own
  comment is explicit: the cursor "is never an authorization boundary; it
  only narrows a WHERE clause that already requires organizationId." The
  "over-fetch by one row to detect `hasMore`" trick appears identically in
  `getNotificationsPage` and `getCommentsPage`.

Global Search introduces a **third, simpler shape**: a bounded, capped
result set per entity type, no "next page" at all (see §4, §8) — a live
dropdown is not a list page, and pretending it needs full pagination would
be over-engineering a feature whose entire value is "see the answer in the
first five results or refine your query."

### 0.5 UI conventions Search must fit into

`src/components/layout/header.tsx` — today: `OrganizationSwitcher` (left),
then `NotificationBell` + email + sign-out (right), inside a
`flex flex-wrap items-center justify-between` bar that already wraps on
narrow viewports. There is **no existing search affordance** anywhere in the
Header, Sidebar (`src/components/layout/sidebar.tsx` — a flat link list:
Dashboard, Clients, Projects, Tasks, Invoices, Team, Activity, Settings), or
`(dashboard)/layout.tsx`.

`src/app/portal/(app)/layout.tsx` is a **completely separate** component
tree — its own `<header>`, its own nav (`PortalNav`), no `NotificationBell`,
no `OrganizationSwitcher`, nothing shared with the staff shell. This mirrors
Comments & Mentions' own portal exclusion (verified in production: zero
Comments UI anywhere in the portal) and settles Search the same way before
any UX is even designed: **Search is staff-only by construction** — there is
no shared surface to bolt it onto in the portal even if it were in scope.

Every existing dropdown/popover in this app (`NotificationBell`,
`OrganizationSwitcher`, `MentionCombobox`) is a **native
`<details>/<summary>`**, not a JS popover library. Every existing modal
(`ConfirmDialog`, `src/components/ui/confirm-dialog.tsx`) is a **native
`<dialog>`** — free focus-trap, free Escape-to-close, free backdrop,
opened imperatively via `useImperativeHandle`/a ref (`dialogRef.current
.showModal()`). There is no client-side keyboard-shortcut listener
anywhere in the codebase today (`grep -rn "keydown\|metaKey\|ctrlKey"` —
zero matches) — Cmd+K is genuinely new machinery, not an existing pattern
to copy, but it must still follow the zero-dependency, native-element
discipline every other interactive surface here already does.

`src/lib/comments/preview.ts`'s `buildCommentPreview()` — a pure, bounded
(140 char), whitespace-collapsing, mention-token-stripping preview builder,
already used by both Activity and Notification metadata — is directly
reusable for a Comment search result's preview (§9), not something to
reinvent.

`src/app/api/attachments/[id]/download/route.ts` is the existing Route
Handler template: `getCurrentUserOrganization()` for identity/org,
`checkRateLimit()` (`src/lib/rate-limit`) before any DB work, a Prisma
lookup scoped by `{ id, organizationId }` together (a foreign-org id and a
nonexistent id are indistinguishable — same discipline
`resolveCommentTarget` documents explicitly). This is the shape Search's own
Route Handler follows (§4).

### 0.6 Test infrastructure

`test/unit/` (25 files, Vitest, pure functions), `test/integration/`
(12 subdirectories, PGlite — a real Postgres compiled to WASM, full
migration chain, `prisma migrate deploy` against it — see
`test/support/local-postgres.ts`), `test/e2e/` (11 Playwright specs against
a real `next start` production build, `TEST_MODE`-gated identity injection
since there's no real Supabase Auth available in this sandbox). A
`test/integration/search/`, `test/unit/search-*.test.ts`, and
`test/e2e/search.spec.ts` slot into this exactly the way
`test/integration/comments/`, `test/unit/comments-*.test.ts`, and
`test/e2e/comments.spec.ts` already did.

---

## 1. Goals

- Let any staff user (`OWNER`/`ADMIN`/`MEMBER`) find a Client, Project, Task,
  Invoice, or Comment in their **current organization** from anywhere in the
  app, in under a few keystrokes, without first navigating to the right list
  page and its own filter form.
- Provide one consistent, keyboard-first entry point (`Cmd+K`/`Ctrl+K`, plus
  a visible Header trigger) instead of five different per-list search boxes
  a user has to remember are separate and non-live.
- Reduce "click through Sidebar → list page → filter form → submit → find
  row" to "press a shortcut, type, press Enter."
- Stay inside this app's own established engineering discipline: org
  isolation as a hard invariant (§6), no new runtime dependency, additive-only
  if any schema change is ever needed, and a staged rollout mirroring
  Notifications/Comments.

Explicitly **not** goals (expanded in §2 and referenced throughout): replacing
per-list filters, fuzzy/typo-tolerant relevance matching, cross-organization
search, a portal-facing feature, or a "search everything including logs"
tool.

## 2. Scope

### In scope (v1)

- **Client** — by `name`, `company`, `email`.
- **Project** — by `name`, and by its `Client.name` (matches the existing
  per-list convention).
- **Task** — by `title`, and by its `Project.name`.
- **Invoice** — by `invoiceNumber`, and by its `Project.name` /
  `Client.name`.
- **Comment** — by `body` (never showing the full body — see §9).

These five are the entities that are simultaneously (a) org-scoped business
data a user actively looks *for*, by name/number/content, and (b) already
have either a stable human-meaningful title (`name`/`title`/`invoiceNumber`)
or, for Comments, content worth matching against. They are also exactly the
five entities the existing per-list `contains`/`insensitive` convention
(§0.3) already searches — Search generalizes a pattern this codebase has
already chosen four times over, rather than inventing a new one.

### Deliberately out of scope for v1

- **Activity** — a timeline/log a user *browses and filters* (it already has
  its own filter bar — `ActivityFilterBar`), not a named "thing" a user
  searches *for*. It is also the highest-volume, append-only, ever-growing
  table in the schema (`Activity` has no soft delete or archival — every
  event since day one is still there); including it would flood every other
  result type with noise and force a retention/relevance story this document
  has no product need to solve yet. Its own entity-specific index
  (`Activity(organizationId, entityType, entityId, createdAt, id)`) is a
  *timeline* index, not built for arbitrary keyword lookup either.
- **Notifications** — personal, ephemeral, per-recipient inbox items, not
  shared organizational knowledge; two different users searching the same
  term would legitimately get different result sets, which is a strange
  property for a feature framed as "find the org's data." More importantly,
  every actionable Notification already links back to the underlying
  entity, which **is** in scope — indexing the Notification row too would
  be indexing the same fact twice under two different relevance stories.
- **Attachments** — only a filename (`originalName`) exists to match on; no
  extracted document text is stored anywhere. Filename-only search is a
  real, much narrower feature than what "search" implies, and worth its own
  design rather than a half-hearted fourth-tier match in this one. Revisit
  if/when text extraction becomes a real requirement.
- **Portal entities** (`PortalUser`, `ClientInvitation`, and the Client
  Portal's own read-only views of Project/Invoice) — Search is staff-only by
  construction (§0.5): there is no shared Header, no Cmd+K, no route the
  portal identity could reach it from, and (§6) the backend must actively
  reject a portal session that tries anyway. This mirrors Comments &
  Mentions' own portal exclusion exactly, already proven correct in
  production.

## 3. UX

### Entry points

- **Header trigger**: a button (not a live, always-open input) reading
  something like `Search… ⌘K`, placed in the Header's existing right-hand
  group (before `NotificationBell`, after `OrganizationSwitcher` — the
  Header is already `flex flex-wrap`; a permanently-expanded text input
  competing for space with the org switcher, bell, email, and sign-out
  button on an already-wrapping bar is worse UX on narrow viewports than a
  small button that opens a full-width overlay). Clicking it opens the same
  dialog the keyboard shortcut does.
- **`Cmd+K` / `Ctrl+K`**: a single global `keydown` listener, mounted once as
  a small client component alongside `Sidebar`/`Header` in
  `(dashboard)/layout.tsx` (staff-only — never mounted in the portal layout,
  per §0.5/§2). Calls `preventDefault()` (stopping the browser's own
  address-bar-focus shortcut) and opens the dialog via the same imperative
  ref pattern `ConfirmDialog` already established
  (`dialogRef.current.showModal()`).

### The dialog

A native `<dialog>` (matching `ConfirmDialog` exactly), not a hand-rolled
overlay: free focus trap, free Escape-to-close, free backdrop-click-to-close,
zero new dependency. Contains:

1. A labeled `<input type="search">`, autofocused on open.
2. A live results area below it.

### Interaction

- **Debounce**: ~200–250ms after the last keystroke before firing a request
  (plain `setTimeout`, no library — matches this app's zero-dependency
  posture everywhere else).
- **Minimum query length**: 2 characters. Below that, no backend request is
  made at all; the results area shows a neutral prompt. This avoids both a
  flood of near-meaningless single-character wildcard queries and a
  misleadingly large "everything matches 'a'" result set.
- **In-flight request cancellation**: a new keystroke's debounced request
  aborts (`AbortController`) any still-pending earlier request, so a slow
  earlier response can never overwrite a newer query's results. This is
  genuinely new machinery for this codebase (every existing form
  interaction is single-shot, full-page or full-section) and is called out
  here explicitly rather than assumed away.
- **Loading**: the *previous* result set stays visible (no flash to empty)
  while a small inline spinner (reusing `SpinnerIcon`) indicates a fetch is
  in flight.
- **Empty state** (query below minimum length, or dialog just opened): a
  neutral prompt, e.g. "Search clients, projects, tasks, invoices, and
  comments."
- **No results**: a distinct, explicit "No results for '{query}'" — never
  confusable with the loading or prompt state.
- **Grouping**: results are grouped by entity type (Clients, Projects, Tasks,
  Invoices, Comments), each with a small group header, in that fixed order.
  Ranking (§5) happens *within* each type's own query; groups themselves are
  always shown in this fixed order rather than dynamically reordered by
  "which type had the best match," keeping the layout predictable across
  searches.
- **Highlighting**: the matched substring within a result's `title` (or
  `preview`, for Comments) is bolded/marked — built the same way Comments'
  own `splitBodyIntoSegments` already turns a string into safe JSX segments
  (never `dangerouslySetInnerHTML`, matching this app's absolute rule): split
  the string at the match indices, wrap the matched slice in a `<mark>`,
  render the rest as plain text.
- **Recent searches — decided against for v1.** This is a small-org tool
  (real production organizations verified during the Comments engagement's
  own Stage 6 smoke test have single-digit-to-low-double-digit rows per
  entity type); a "recent searches" feature adds real complexity (client
  storage, and a privacy question — search terms may contain a client's real
  name) for marginal benefit at this scale. Revisit only if real usage data
  ever shows people re-typing the same queries repeatedly.
- **Keyboard navigation**: Up/Down moves a single "active" index across the
  *flattened* result list (spanning group boundaries, so arrowing down from
  the last Client scrolls into the first Project, etc.); Enter navigates to
  the active result and closes the dialog; Escape closes the dialog (native,
  free); Tab stays trapped inside the dialog (native `<dialog>` focus
  containment).

## 4. Search contract

One backend "search service" (one function per entity type, plus a thin
aggregator calling all five in parallel), fronted by exactly one Route
Handler: `GET /api/search`.

### Why a Route Handler, not a Server Action

Every existing interactive *write* in this app is a Server Action
(`useActionState`-driven, matching the whole codebase's convention) — but
every one of them is triggered by a single, discrete user action (a button
click, a form submit), never by rapid, high-frequency, cancel-and-replace
keystroke-driven calls. A live debounced search is fundamentally a *read*,
shaped like a plain, abortable `fetch()` — which is exactly what a Route
Handler serves, and exactly what this codebase already uses for its other
non-mutating, non-page GET needs (`attachments/[id]/download`,
`portal/attachments/[id]/download`). This is a deliberate, explicit
departure from "Server Action for everything," justified by the interaction
shape being genuinely different (a query with no revalidation/mutation
concerns at all), not a stylistic preference.

### Request

```
GET /api/search?q=<string>
```

`organizationId` is never a query parameter — resolved exclusively,
server-side, via `getCurrentUserOrganization()` (§6). `q` is the only
client-supplied input.

### Response shape

```ts
type SearchResultType = "CLIENT" | "PROJECT" | "TASK" | "INVOICE" | "COMMENT";

type SearchResult = {
  type: SearchResultType;
  id: string;
  /** Client.name / Project.name / Task.title / "Invoice #{invoiceNumber}" / the Comment's parent entity's own label */
  title: string;
  /** Project's client name, Task's project name, Invoice's project+client, Comment's author + relative time — or null */
  subtitle: string | null;
  /** Comment body preview ONLY (buildCommentPreview) — always null for every other type */
  preview: string | null;
  /** Allowlisted, server-built relative path — see §10 */
  url: string;
  /** Which field the query actually matched, so the UI highlights the right one */
  matchField: "title" | "subtitle" | "preview";
};

type SearchResultGroup = {
  type: SearchResultType;
  results: SearchResult[];
};

type SearchResponse = {
  query: string;
  groups: SearchResultGroup[];
};
```

No field beyond this shape is ever serialized — the same allowlist
discipline `Activity.metadata`/`Notification.metadata` already enforce
(never a raw row, never more than a formatter needs). Bounded per-type
result counts (§8), never a paginated list — a "view all N results" is
explicitly future work (§2/§8), not this stage's concern.

## 5. Ranking

Ranking is computed **independently per entity type** (five separate
queries, five separate `ORDER BY` expressions), each capped at its own
top-N (§8), then assembled into the fixed-order UI groups (§3). A single
merged, cross-type ranked list would need one `UNION`-shaped query across
five different tables with five different column sets — meaningfully harder
to write, test, and reason about than five independent, parallel,
already-proven-shaped queries (mirroring exactly how `CommentsSection`
already runs its own two independent queries via `Promise.all`) — for a
marginal UX benefit in a small, keyboard-navigated dropdown. This is a
deliberate simplification, flagged here explicitly as a place a later stage
could revisit if real usage ever shows people want one "best guess" result
surfaced above everything else, regardless of type.

Within each type, tiers are evaluated in this order — the first tier a row
matches wins; ties within a tier break by most-recently-`createdAt`/
`updatedAt` first (consistent with every existing list's own default sort):

1. **Exact match** (case-insensitive) on the primary field — `Client.name`,
   `Project.name`, `Task.title`, `Invoice.invoiceNumber`. The strongest
   possible signal: a user who types a full, exact name or number almost
   certainly wants that one record.
2. **Prefix match** — primary field starts with the query. Matches how
   people actually search ("Acme" while thinking of "Acme Corp").
3. **Contains match on the primary field** — substring anywhere (e.g.
   "Corp" matching "Acme Corp").
4. **Contains match on a secondary field** — `Project.client.name` (for
   Project results), `Task.project.name`, `Invoice.project.name` /
   `Invoice.project.client.name`. A real but weaker signal: a query that
   only matches the *context* field ranks below any primary-field match of
   the same or better tier — exactly mirroring the existing
   `buildProjectWhere`/`buildTaskWhere`/`buildInvoiceWhere` convention of
   `OR`-ing in one relation's name, just now ranked rather than left
   unordered.

Comments are a partial exception (no primary "title" of their own — see
§9): a Comment result's rank is body-contains-query only (roughly tier-3
equivalent), since there is no meaningful "exact"/"prefix" concept for
free-text body content in v1. Matching by the comment's *author* name is
explicitly not in v1's minimum bar (searching "who said something" is a
different, later feature) — it could be added as an additional lower tier
without changing this document's core model.

## 6. Security

Search must satisfy every invariant this app already enforces elsewhere, not
a weaker "read-only so it's fine" version of them.

- **Organization isolation**: `organizationId` is resolved exclusively via
  `getCurrentUserOrganization()`, server-side, inside the Route Handler —
  never a client-supplied parameter, never derived from anything in the
  request body/query beyond `q`. Every one of the five per-type queries has
  `organizationId` (or, for Task/Invoice, the equivalent
  `project: { organizationId }` join — see below) as its **first**,
  unconditional `WHERE` clause, exactly like `buildActivityWhere`'s own
  documented discipline: "organizationId is always the first, non-optional
  condition... a foreign-org filter value simply yields zero rows."
- **Membership**: calling `getCurrentUserOrganization()` *is* the membership
  check (§0.2) — no separate authorization step is layered on top, matching
  `attachments/[id]/download/route.ts`'s own reliance on exactly this.
- **A scoping-convention distinction between Task and Invoice**: `Task`
  still carries a direct, nullable `organizationId` column that isn't
  guaranteed populated — `buildTaskWhere` scopes by `project: { organizationId }`
  only, and Search's own Task query must follow that same convention, not
  the direct column, to avoid a Task whose own `organizationId` happens to
  be null being silently excluded or, worse, matched against the wrong org.
  `Invoice` is different: since migration
  `20260911090000_repair_invoice_organization_scope` (see
  `docs/invoicing-architecture.md`), `Invoice.organizationId` is a
  required column kept consistent with `Project.organizationId` by every
  write path, and is now the canonical direct tenant predicate —
  `buildInvoiceWhere`/`searchInvoices` scope by it directly, retaining
  `project: { organizationId }` (and, for Search, `client: { organizationId }`)
  only as defense in depth, not as the primary mechanism. This is a
  concrete implementation note, not an open question — the existing query
  files already show the correct answer for each.
- **Portal isolation**: a `PortalUser`-only session must never receive a
  result. `getOrCreateUser()` already redirects such an identity to
  `/portal` before any `organizationId` resolves — but a `fetch()` call from
  client JS does not "follow a redirect" the way a page navigation does in
  a way the caller can meaningfully act on; this needs an explicit decision
  in Stage 2 (flagged as an open question in the closing report) rather than
  silently trusting the existing redirect-based guard to behave correctly
  for a JSON API caller. The safe default direction: the search Route
  Handler should return a plain `401`/`403` for any identity that isn't a
  resolvable staff Membership, failing closed and unambiguously for a
  fetch-based caller, rather than relying on `redirect()`'s page-oriented
  semantics.
- **Soft delete**: the *only* soft-deletable in-scope entity is Comment.
  Every Comment query must include `deletedAt: null` explicitly. This is
  stricter than the Comments UI itself (which still shows a "Comment
  deleted" placeholder for a soft-deleted row) — search should omit a
  deleted comment **entirely**, never surface its body or even its
  existence, since "supposedly removed content is discoverable by search"
  would be a real trust violation the placeholder-in-a-thread pattern
  doesn't have (a thread's own reader already knows something was there;
  search is a stranger to that context finding it fresh).
- **No row-level ACL beyond Membership** (§0.2): any org member's search
  includes every org member's Comments, Clients, Projects, Tasks, Invoices —
  exactly matching how every existing list page and `getCommentsPage`
  already behave. Edit/delete permission (author-only edit, author-or-
  moderator delete) is completely irrelevant to whether something is
  *searchable* — only to what the destination page lets you do once you
  arrive.
- **No cross-org leakage via error shape or timing**: a foreign-org id (or a
  genuinely nonexistent one) must be indistinguishable — both simply produce
  zero results, mirroring `resolveCommentTarget`'s own explicit "a
  foreign-org id and a genuinely nonexistent id are indistinguishable"
  discipline. No distinct "found but not yours" error path, ever.
- **Rate limiting**: a new `SEARCH_LIMIT` in `src/lib/rate-limit/limits.ts`,
  per authenticated user (not per IP — every existing per-user limit in that
  file, e.g. `INVITE_MEMBER_LIMIT`, uses this same shape), generous enough
  for legitimate fast typing at the debounce interval (e.g. 60/minute), tight
  enough to blunt a scripted enumeration attempt against the search endpoint.
- **No PII/query text in logs** beyond this app's existing convention
  (nothing currently logs raw request bodies or query strings anywhere —
  Search should not be the first feature to start).

## 7. Database strategy

### What already exists

`Client(status)`, `Client(userId)`, `Client(organizationId)`;
`Project(status)`, `Project(ownerId)`, `Project(organizationId)`;
`Task(status)`, `Task(dueDate)`, `Task(organizationId)`;
`Invoice(status)`, `Invoice(dueDate)`, `Invoice(projectId)`,
`Invoice(organizationId)`; `Comment(organizationId, entityType, entityId,
createdAt, id)`, `Comment(authorId, createdAt)`. Every one of these is an
equality/range index for filtering and ordering — **none of them is a text
index**, and the existing `contains`/`insensitive` per-list search
(§0.3) already runs today with **no** supporting text index at all.

### What's actually needed for v1: nothing new, with one caveat

At this app's real, verified scale (single-digit-to-low-double-digit rows
per entity type per organization, confirmed directly during the Comments
feature's own production verification, not assumed), a query shaped
`WHERE organizationId = ? AND (name ILIKE '%x%' OR ...)` is a sub-millisecond
operation: the existing `organizationId` index already narrows to "this
org's rows" before the `ILIKE` ever has to scan anything beyond a handful of
records. Five such queries, run in parallel, are trivial at this scale.

**The one caveat**: `Comment` has no plain `(organizationId)` or
`(organizationId, deletedAt)` index — its only index is entity-scoped
(`organizationId, entityType, entityId, createdAt, id`), which doesn't help
a *cross-entity* "every comment in this org" scan the way Client/Project/
Task/Invoice's own direct `organizationId` indexes already help theirs.
Comments are also the fastest-growing of the five in-scope tables (created
continuously, never archived). This is the one concrete index worth adding
in a **later** stage (Stage 2, its own additive migration): something in the
shape of `@@index([organizationId, deletedAt, createdAt])` on `Comment`,
matched to whatever the real Stage 2 query turns out to need. Everything
else needs no new index for v1.

### What NOT to do, and why

Do **not** reach for Postgres full-text search (`tsvector`/
`to_tsvector`/`GIN`) or `pg_trgm` trigram indexes for v1, despite either
being the reflexive "correct" answer for "search":

1. **No evidence of need.** The data volume this document can actually
   verify is far below where a sequential-scan-after-org-filter becomes
   slow. Introducing FTS now optimizes a problem that does not exist yet.
2. **FTS is a schema decision, not a query decision.** It needs either a
   generated/stored `tsvector` column (an actual migration, explicitly out
   of scope for Stage 1) or an expression index, plus real product
   decisions (which dictionary/language config, stemming behavior,
   weighting) with no forcing need to make yet.
3. **`pg_trgm` requires a Postgres extension.** On this project's
   Supabase-managed database, enabling an extension is an explicit,
   auditable operational step — not a decision to bury inside a design
   document. Surfaced here as a real cost, deferred, not hidden.
4. **One mental model, not two.** The existing four list pages already use
   `contains`/`insensitive` successfully; reusing it for Search keeps this
   codebase's contributors reasoning about one search technique
   (case-insensitive substring match) instead of "simple ILIKE for lists,
   full-text ranking for global search" for what is, underneath, the same
   class of query on the same tables.

### When to revisit

If a real organization's row counts grow into the thousands-per-entity-type
range (none does today), or if the performance tests in §8/§12 ever measure
a real bottleneck, the natural next step is a `pg_trgm` GIN index on the
specific searched columns — an additive migration, and a strict *speed*
upgrade with **zero query-shape change** (trigram indexes accelerate the
exact same `ILIKE '%x%'` queries already written). Moving to full FTS would
instead change query semantics (tokenization, relevance scoring) and require
rewriting every query — a materially bigger step to justify only with real
evidence, never preemptively.

## 8. Performance

- **Limit**: top 5 results per entity type (25 max across all five types) for
  the live dropdown. Generous enough to be useful in the common case, small
  enough to render instantly with no internal scrolling/pagination of its
  own.
- **Pagination**: none in v1 (§2, §4) — a "see all N results" view is
  explicitly future work; a user who needs more than a handful of matches
  should refine the query or fall back to the entity's own list page, which
  already has real, tested pagination.
- **Debounce + cancellation**: ~200–250ms client-side debounce, plus
  `AbortController`-based cancellation of any still-in-flight earlier
  request on every new keystroke (§3) — this is the one piece of genuinely
  new client-side machinery this feature requires; every existing
  interactive surface in this app is single-shot and never needed it.
- **Caching**: none server-side for v1 — every debounced keystroke is a
  fresh query; the data scale (§7) makes this fine, and adding a caching
  layer for a problem that isn't measured yet would be premature complexity
  matching the same reasoning §7 already applies to indexing.
- **N+1**: every per-type query must fetch any needed relation (a Project's
  client name, a Task's project name, an Invoice's project/client name) via
  a single Prisma `select`/`include` in that same query — never a per-result
  follow-up — mirroring `getCommentsPage`'s own "author/mentions via
  include, one query" discipline exactly. Verified in integration tests via
  an explicit query-count assertion (§12), the same discipline this app's
  test suite already applies elsewhere.
- **Latency goal**: sub-200ms server response time at this app's real data
  scale (five parallel queries, each touching at most a few hundred
  org-scoped rows). This is a directional target for Stage 2's own testing
  to measure against — there is no production traffic data yet to calibrate
  a contractual SLA, and this document does not invent one.

## 9. Comments

Searching comment content follows the exact allowlist discipline the
Comments & Mentions feature already established for every other surface
that shows comment data outside the comment thread itself (Activity,
Notifications, email):

- **Query**: `WHERE organizationId = ? AND deletedAt IS NULL AND body ILIKE
  '%query%'` — never scoped by entity in advance (a global search spans both
  Project and Task comments; the result's own `title`/`url` carries which
  parent it belongs to).
- **Never the full body.** The result's `preview` field is
  `buildCommentPreview(comment.body)` verbatim (`src/lib/comments/
  preview.ts`) — already bounded to 140 characters, already collapses
  whitespace/control characters to a single clean line, already strips raw
  `@[Name](user:uuid)` token syntax down to just the display name. This is
  the *third* consumer of this exact pure function (after Activity and
  Notification metadata) — reused, not reimplemented.
- **Title/subtitle for a Comment result**: since a Comment has no name of
  its own, `title` is its **parent entity's own label** (the Project name or
  Task title it's attached to — the same `parentEntityLabel` concept
  `resolveCommentTarget` already computes for Activity/Notification
  metadata), and `subtitle` is the author's name plus a relative timestamp
  (e.g. "Jane Doe · 2 days ago") — enough context to recognize which
  thread this is before reading the preview.
- **Highlighting** happens on the already-safe `preview` string, never on
  the raw `body` — the same "operate only on already-sanitized output"
  rule the rest of this document applies everywhere content reaches a UI.

## 10. Result links

Every `url` is built server-side from an allowlisted, per-type path
template, keyed by the result's own `type` enum value — **never**
string-concatenated from anything client-supplied — exactly mirroring
`resolveNotificationLinkPath`'s own "allowlisted per type, never built from
arbitrary metadata" discipline.

| Type | `url` |
|---|---|
| Client | `/clients/{id}/edit` |
| Project | `/projects/{id}/edit` |
| Task | `/tasks/{id}/edit` |
| Invoice | `/invoices/{id}/edit` |
| Comment | parent entity's own edit route + `#comment-{id}` |

**Comments deliberately reuse the exact deep-link mechanism Comments &
Mentions Stage 4 already built and already verified correct in production**
(the `parentEntityId`-carrying `Notification.metadata` /
`resolveMentionedLinkPath` pattern): a Comment search result links to
`/projects/{parentId}/edit#comment-{commentId}` or
`/tasks/{parentId}/edit#comment-{commentId}`. Search's own version is
simpler than the Notification case — the whole Comment row (including
`entityType`/`entityId`) is already in hand from the same query that found
it, with no narrow-metadata-allowlist indirection needed the way a
Notification row required.

Every one of these destination routes **already independently re-verifies
org ownership on load** (confirmed for Project/Task during the Comments
engagement's own Stage 5 audit — a cross-org id renders "Page not found").
This is the real backstop: even a hypothetically stale or incorrect search
result URL cannot leak data, because the destination page's own existing
authorization check is never bypassed or assumed away by Search.

## 11. Accessibility

- **Keyboard**: `Cmd+K`/`Ctrl+K` opens the dialog; Escape closes it (native
  `<dialog>`, free — same as `ConfirmDialog`); Up/Down moves the active
  result across the flattened list; Enter activates the active result; Tab
  stays trapped inside the dialog (native focus containment).
- **ARIA**: the input carries an explicit accessible name (visually hidden
  label if needed, matching `MentionCombobox`'s own `aria-label="Search
  teammates to mention"` convention); the results container uses
  `role="listbox"`/`role="option"` — the same lightweight pattern
  `MentionCombobox` already established, deliberately not the full W3C ARIA
  combobox pattern (which nothing in this codebase implements today, and
  introducing it for one feature would be a heavier, inconsistent precedent
  for the next contributor). The active option is exposed via
  `aria-activedescendant` on the input, plus a visible, non-color-only
  highlight style (matching the Comments engagement's own "mentions never
  conveyed by color alone" rule).
- **Focus management**: opening the dialog moves focus to the input
  immediately; closing it (Escape, backdrop click, or selecting a result)
  returns focus to whatever triggered it — native `<dialog>` already handles
  return-focus on close, the same as `ConfirmDialog` gets for free today.
- **Screen readers**: an `aria-live="polite"` region — the same pattern
  already used by `toast-provider.tsx`, the one existing precedent in this
  codebase — announces result-count changes ("5 results", "No results"),
  throttled so it doesn't fire on every debounced keystroke, only on an
  actual settled result set.
- **Grouping semantics**: each entity-type group uses a real heading or
  `role="group"`/`aria-label` pairing, so a screen-reader user can navigate
  between sections, not just individual results one at a time.

## 12. Testing strategy

- **Unit** (`test/unit/search-*.test.ts`) — pure functions only: the
  per-type ranking/tier function, the highlight-segment splitter (mirroring
  `splitBodyIntoSegments`'s own already-unit-tested shape), the
  allowlisted-URL builder (mirroring `resolveMentionedLinkPath`'s own test
  suite), the minimum-query-length gate and query-trimming/normalization.
- **Integration** (`test/integration/search/`, PGlite, mirroring Comments'/
  Notifications'/Activity's own proven setup) — real Prisma queries against
  a full migration chain: organization isolation (a same-named Client in a
  different org never appears), soft-delete exclusion (a deleted Comment
  never appears, even with a matching body), ranking order (deliberately
  crafted fixtures proving exact > prefix > contains > secondary-field),
  bounded per-type limits, an explicit query-count assertion for N+1, the
  minimum-query-length gate, rate limiting, and the Task/Invoice
  organization-scoping convention (§6) specifically.
- **E2E** (`test/e2e/search.spec.ts`, Playwright against a real production
  build, `TEST_MODE` identity injection — the same pattern every other spec
  in this suite already uses): `Cmd+K` opens the dialog; typing produces
  debounced results; keyboard navigation (arrows + Enter) reaches the
  correct destination; Escape closes; empty/loading/no-results states
  render distinctly; each of the five result types links correctly
  (including a Comment's `#comment-{id}` anchor, reusing the exact
  assertion style `comments.spec.ts` already established); a cross-org
  fixture never appears; a Client Portal identity has no search UI and no
  reachable route at all (mirroring the existing "the Client Portal has no
  Comments section anywhere" test, applied to Search).
- **Security** — a dedicated adversarial pass: a forged `active_organization_id`
  cookie, a `PortalUser` session hitting `/api/search` directly (not through
  any UI), a rate-limit-exceeding burst, and an explicit assertion that the
  response never contains a field outside the allowlisted `SearchResult`
  shape — mirroring the metadata-allowlist test discipline Comments &
  Mentions already established.
- **Performance** — a lightweight benchmark-style integration test seeding a
  realistic-but-generous row count (a few hundred rows per type) and
  asserting the five parallel queries complete within the directional
  latency budget from §8. Not a rigorous load test — enough to catch an
  accidental N+1 or missing-limit regression before it ships, the same
  spirit as this app's existing query-count assertions elsewhere.

## 13. Rollout plan

Mirroring the Notifications Center's and Comments & Mentions' own proven
staging — schema only where truly warranted, backend before API, API before
UI, UI before the audit, audit before production:

- **Stage 2 — Database & backend contract.** The one flagged Comment index
  (§7), if confirmed warranted, as its own additive migration. The five
  per-type search service functions plus the aggregator, fully unit- and
  integration-tested. No Route Handler, no UI yet — mirrors Comments Stage
  2's own "schema/backend only" discipline exactly.
- **Stage 3 — API & security.** The `/api/search` Route Handler itself,
  wired to Stage 2's service: rate limiting, organization scoping, the
  portal-rejection decision (§6) made concrete, soft-delete exclusion — all
  verified by integration tests hitting the route directly. Still no UI —
  mirrors how Comments Stage 3 shipped a fully working, fully tested backend
  before any UI existed.
- **Stage 4 — UI.** The Header trigger, the `Cmd+K` dialog, debounced
  fetching with cancellation, grouping/highlighting/keyboard navigation, all
  empty/loading/no-results states, full E2E coverage. Mirrors Comments Stage
  4 exactly: UI is built last, on top of an already-proven backend.
- **Stage 5 — Full audit & PR.** A comprehensive diff/security/regression
  audit in the same shape as the Comments engagement's own Stage 5, ending
  in a PR (base `main`, head `feature/global-search`) only once everything
  is green.
- **Stage 6 — Production verification.** Any migration applied to the
  shared database, merge, and a real production smoke test with throwaway
  fixtures — mirroring the Comments engagement's own Stage 6 report, adapted
  to Search's own specific checks: organization isolation, portal rejection,
  ranking sanity against real data, and each result type's deep link
  (including the Comment `#comment-{id}` anchor).
