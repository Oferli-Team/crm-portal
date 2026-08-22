# Onboarding — Architecture & Design (Stage 1)

Design-only. No code, no migration, no UI in this stage — the same
discipline `docs/comments-architecture.md` and `docs/search-architecture.md`
both followed in their own Stage 1s, which this document mirrors rather
than reinvents. Where a decision here reuses an existing mechanism
verbatim, that mechanism is named, not re-explained.

---

## 0. Grounding: what already exists

Read in full before writing a line of this document: `prisma/schema.prisma`,
`src/lib/current-user.ts`, the dashboard/Header/Sidebar/layout, the staff
and Client Portal invitation flows end to end, every list page and its
empty state, Settings, Attachments, Activity, and all three existing
architecture docs (Comments, Notifications, Search) plus `README.md` and
`docs/testing.md`. What follows is what actually exists today, not an
assumption.

### 0.1 There is no onboarding today, and no field to build one on

First login runs exactly this path (`src/lib/current-user.ts`):

1. `getOrCreateUser()` upserts a `User` row from the Supabase Auth session.
2. `getOrCreateOrganizationId()` — if this user holds no `OWNER`
   Membership anywhere — silently creates a brand-new `Organization`
   named `"${user.name}'s Workspace"`, a unique `slug`, and an `OWNER`
   `Membership`, all inside one transaction.
3. The user lands on `/dashboard`.

Nothing between steps 2 and 3 shows a welcome screen, a checklist, or any
guidance at all. The dashboard the user actually sees
(`src/app/(dashboard)/dashboard/page.tsx`) renders every KPI at zero,
"No upcoming tasks.", "Nothing overdue.", "No invoices yet." — a
correctly-rendered, entirely empty product, with no signal about what to
do next beyond the Sidebar itself.

Neither `Organization` (`id, name, slug, createdAt, updatedAt` + relations
only) nor `Membership` nor `User` carries any onboarding-related field.
There is nothing to repurpose — any persisted onboarding state is new
surface, by construction.

### 0.2 The one thing that already, quietly, *is* onboarding

Every list page that has a real creation dependency already encodes it in
its own empty state, computed from a live count query run on every page
load — not a stored flag:

| Page | Empty state (no dependency) | Empty state (dependency missing) |
|---|---|---|
| `/clients` | "No clients yet" / "Get started by adding your first client." → *Add client* | — (Client is the root of the chain) |
| `/projects` | "No projects yet" / "Get started by adding your first project." → *Add project* | `clientCount === 0` → "You need a client first" / "Projects must belong to a client. Add one before creating a project." → *Add client* |
| `/tasks` | "No tasks yet" / "Get started by adding your first task." → *Add task* | `projectCount === 0` → "You need a project first" / "Tasks must belong to a project. Add one before creating a task." → *Add project* |
| `/invoices` | "No invoices yet" / "Get started by adding your first invoice." → *Add invoice* | `projectCount === 0` → "You need a project first" / "Invoices must belong to a project. Add one before creating an invoice." → *Add project* |
| `/team` (pending invitations) | "No pending invitations" / "Invite someone below to add them to your organization." | — |
| Client Portal access (per-Client) | "No portal users yet" / "Invited contacts appear here once they accept." | — |
| `/activity` | "No activity yet" / "Actions your team takes will show up here." | — |

This is a real, load-bearing, already-shipped fact this design leans on
hardest: **the exact dependency chain (Client → Project → {Task, Invoice})
this document proposes for onboarding's own step order is not a new
opinion — it's the chain the product already enforces and already
messages**, via `EmptyState` (`src/components/ui/empty-state.tsx`, used in
17 places today — the single most reused UI primitive in this app besides
`Table`). Onboarding does not replace this mechanism; §10 covers exactly
how the two coexist.

### 0.3 The invitation flows onboarding's own "invite" steps reuse verbatim

**Staff** (`src/app/(dashboard)/team/actions.ts`, `src/app/invite/[token]/`):
`inviteMemberAction` — OWNER/ADMIN only, `INVITE_MEMBER_LIMIT`-rate-limited,
a 7-day token (`INVITATION_TTL_MS`), one `Invitation` row
(`@@unique([organizationId, email])`), an `INVITATION_SENT` Activity row,
best-effort email via `sendInvitationEmail` (graceful "copy the link
instead" fallback if unset). Accepting
(`acceptInvitationAction`) creates the `Membership` inside a transaction,
logs `INVITATION_ACCEPTED`, sets the new member's active org cookie, and
redirects to `/dashboard` with a `"Joined organization"` toast — **also
with zero onboarding**, even for someone joining a brand-new, still-empty
org.

**Client Portal** (`.../clients/[id]/edit/portal-access-section.tsx`,
`src/app/portal/invite/[token]/`): the identical shape, scoped to one
`Client` instead of the `Organization` — `ClientInvitation`,
`PortalUser`, the same expiry/rate-limit/Activity discipline, the same
"already accepted" / "expired" / "wrong email, sign out" states. A
`PortalUser` who accepts lands on `/portal` — a read-only overview
(`src/app/portal/(app)/page.tsx`: active-projects count, open-invoices
count, outstanding amount, "No projects yet." / "No invoices yet.")
with, again, no onboarding of any kind. See §17 for why the Portal side
of this document stays deliberately thin.

Onboarding's own "Invite a teammate" / "Invite a Portal User" steps are
**entry points into these exact, already-built flows** — a link to
`/team` (with the invite form already in view) and a link to the
relevant `/clients/[id]/edit` Portal Access section. Nothing about either
flow needs to change.

### 0.4 There is no general Organization/account settings page

`/settings` today has exactly one sub-route: `/settings/notifications`
(`src/app/(dashboard)/settings/notifications/page.tsx`) — per-type,
per-channel notification preferences, mirroring `NotificationPreference`'s
own lazy-row/default-true model. There is **no** page to rename the
organization, no "Workspace settings," nothing. `Organization.name`
(`"${user.name}'s Workspace"` at creation) has literally never been
user-editable at any point in this codebase's history. This matters
directly for §6's step design and is the one place this document proposes
touching an existing page (adding one settings entry point, not a new
settings feature — see §12).

### 0.5 No wizard/modal precedent exists — and what does

There is no multi-step wizard anywhere in this app. The only two places a
native `<dialog>` is used are `ConfirmDialog` (destructive-action
confirmation, user-triggered, never automatic) and the global search
dialog (`Cmd+K`, user-triggered). **Nothing in this codebase today opens
a modal automatically, unprompted, on page load.** This is a real,
deliberate precedent — every existing "here's what to do" surface
(`EmptyState`, the dashboard's own zero-state cards) is an inline
part of the page, never an interruption. §11/§12 argue explicitly for why
onboarding should not be the first feature to break this.

Established accessibility patterns worth reusing: `aria-live="polite"`
regions (`toast-provider.tsx`, and Search's own result-count announcer);
`role="listbox"`/`role="option"` + `aria-activedescendant` (the mention
combobox, Search); native `<dialog>` for free focus-trap/Escape/return-focus
when a dialog is genuinely warranted; "never color-only" badges
(`StatusBadge`). Established responsive pattern: a component changes its
**own** layout at a breakpoint (`Sidebar` collapses to a horizontal top
bar below `md:`; the notification dropdown becomes a full-width sheet on
mobile) — never a second, parallel mobile component tree. §11–§13 apply
all of these to onboarding rather than inventing new ones.

### 0.6 Billing exists, but not on this branch (historical — as originally written)

`docs/billing-architecture.md` and a working Subscription/Entitlements/
Trial system existed on `feature/billing-subscriptions`, **not yet merged
into `main`** as of this document's original writing. The example step
list this stage was asked to evaluate includes "Review Billing." §16
addresses this directly: the step was designed to be safe to include
*today* (before billing merged) and to activate automatically once it
did, without this document assuming billing was present. Billing has
since fully merged and is live, and `REVIEW_BILLING` itself is now
available (Sale-Ready Phase E, E3.3) — see §16's own "Current state" note.

### 0.7 Testing conventions (mirrored unchanged in §19)

Three layers, per `docs/testing.md`: unit (Vitest, pure functions, no
I/O), integration (Vitest + PGlite-backed real Postgres, real Server
Actions, mocked only `cookies()`/`redirect()`/`notFound()`/
`revalidatePath()`/Supabase Auth), E2E (Playwright, real Chromium, real
`next build`+`next start`, `TEST_MODE` identity injection). Kept
deliberately small at the E2E layer — most logic lives at unit/integration.

---

## 1. Goals

- Get a brand-new, empty `Organization` to a **productive first session**
  as fast as possible: at least one real `Client` and one real `Project`
  in the system, since virtually every other feature (`Task`, `Invoice`,
  `Attachment`, `Comment`, Search results, Dashboard metrics) is either a
  child of `Project` or meaningless without one.
- Make the **existing** dependency chain (§0.2) visible and navigable as
  a single, coherent checklist, rather than something a user only
  discovers by hitting a wall on `/projects` and reading an empty-state
  message.
- Surface the two "bring other people in" flows (staff invite, Client
  Portal invite) that already exist and already work, but that a
  brand-new OWNER — alone in an empty workspace — has no reason to know
  about yet.
- Never block, gate, or interrupt. Onboarding is guidance layered on top
  of a fully-usable product, matching this app's existing philosophy
  (§0.2, §0.5) everywhere else: an empty state nudges, it never prevents
  navigation.
- Be honest and self-correcting: progress reflects the organization's
  **actual current data**, not a one-time checkbox a user could satisfy
  once and then contradict (e.g. by deleting their only Client) without
  the checklist noticing. §9 is built entirely around this property.
- Work identically for the common case this product is built for
  (README: "freelancers and small agencies") — a **solo** user for whom
  "invite a teammate" is not a failure to complete onboarding, but a
  permanently correct end state.

### Non-goals (this stage, and likely several stages beyond it)

- **A blocking, linear wizard.** No step gates any other page; §0.5/§11
  cover why. A user can ignore onboarding entirely and use the full
  product, exactly as every user has been able to since before this
  document existed.
- **Per-user onboarding state.** §9 argues this explicitly — state is
  per-`Organization`, not per-`Membership`.
  A second teammate joining an already-populated org sees an
  already-mostly-complete checklist, not a reset one.
  See §9 for the one place this creates a small, accepted tradeoff.
- **Portal onboarding as a first-class flow.** `PortalUser`s can't create
  anything (§0.1 read-only overview) — there's very little "onboarding"
  can add. §17 covers the one thing worth doing there and explicitly
  scopes the rest out.
- **A generic, reusable "product tour" framework.** This is one
  onboarding checklist for one product surface (the staff dashboard), not
  a platform for building future tours/spotlights. If that's wanted
  later, it's a new, separately-justified design — not a default
  extension of this one.
- **Gamification** (progress bars with animations, confetti, badges).
  A plain checklist with a fraction ("3 of 6 done") is enough — this
  product's own tone (plain text empty states, no illustrations, no
  marketing copy anywhere in the dashboard) argues against anything
  louder.
- **Rewriting or replacing any existing empty state.** §10 is explicit:
  every `EmptyState` in §0.2's table stays exactly as it is.
- **Applying to Billing before that branch merges.** §16 covers exactly
  how the design stayed correct either way, and what happened once it did.

---

## 2. When onboarding starts

Onboarding is a property of the **Organization**, triggered the moment an
`Organization` is created with **no onboarding-relevant data in it yet**
— concretely, the same transaction in `getOrCreateOrganizationId()` that
creates a brand-new personal workspace (§0.1, step 2) is the only place a
"this org has never had onboarding progress" state begins. It is
*not* triggered by:

- **Every login** — onboarding is not a login-time interstitial; a
  returning user whose org is already 100% done (or explicitly dismissed,
  §5) never sees it again, computed the same way on every page load, not
  remembered via a session flag.
- **A new *User*.** A user who is invited into an *existing* org (staff
  or, structurally, any future scenario) is joining that org's own
  progress, already however far along it is — not starting their own.
  This is a direct consequence of §9's org-scoped model, and is the
  correct behavior: a teammate invited into a 50-client agency's
  workspace should not be told to "create your first client."
- **A blank click/route.** There is no `/onboarding` route in this
  design (§12) — the checklist is a section of `/dashboard`, so
  "starting" onboarding is nothing more than that section rendering with
  its first (or only remaining) unstarted step.

Displayed automatically — no explicit opt-in — the first time any member
of that organization loads `/dashboard`, for as long as the organization
has undismissed, incomplete progress (§5). This mirrors the existing
`EmptyState` philosophy exactly: nothing needs to be turned on, an empty
condition simply renders differently than a full one.

---

## 3. When onboarding is considered complete

Two independent ways, either sufficient on its own:

1. **Every step is either done or explicitly skipped.** "Done" for a
   business-data step means the underlying row(s) exist (§9); "skipped"
   is a real, distinct, persisted state a user chose (§5/§9) — not the
   same as "not reached yet."
2. **The whole checklist is explicitly dismissed** via a "Finish"/"Hide
   this" action, regardless of how many individual steps are actually
   done. This is the pressure-release valve: an OWNER who genuinely
   never wants teammates or a Client Portal, or who simply doesn't want
   the checklist taking up space, can make it go away permanently without
   being forced to click "Skip" six separate times.

Completion is **not** a one-time event that then gets frozen — see §9's
"why not a `completedAt` timestamp" reasoning. A dismissed/finished
checklist stays hidden by default, but its underlying steps keep
reflecting live data if ever reopened (§5, §8).

---

## 4. How progress is determined

**Computed, per step, from real data — not a stored "I did this" flag —
for every step that corresponds to a real business fact.** This is the
single most important decision in this document and is argued fully in
§9; this section states the mechanism plainly:

| Step | "Done" condition | Query shape (already exists in spirit — §0.2) |
|---|---|---|
| Welcome | Explicitly acknowledged (no business-data equivalent) | persisted (§9) |
| Create first Client | `prisma.client.count({ where: { organizationId } }) > 0` | identical to `clients/page.tsx`'s own total |
| Create first Project | `prisma.project.count({ where: { organizationId } }) > 0` | identical to `projects/page.tsx`'s own `clientCount`-style check |
| Create first Task | `prisma.task.count({ where: { organizationId } }) > 0` | identical to `tasks/page.tsx`'s own `projectCount`-style check |
| Invite a teammate | `prisma.membership.count({ where: { organizationId } }) > 1` (more than just the creating OWNER) | new, same shape |
| Invite a Portal User | `prisma.portalUser.count({ where: { client: { organizationId } } }) > 0` | new, same shape |
| Review Billing | Explicitly acknowledged (no business-data equivalent) — see §16 for why, now that the step is available (Sale-Ready Phase E, E3.3) | persisted (§9) |
| Finish | Explicitly acknowledged / whole widget dismissed | persisted (§9) |

Every one of these (other than Welcome/Review Billing/Finish) is
answerable with a single, cheap, already-indexed `count`/
`exists` query — the same kind of query `clients/page.tsx`,
`projects/page.tsx`, and `tasks/page.tsx` already run on every request
for their own empty states. A dedicated `getOnboardingProgress(organizationId)`
function (§9, §20 Stage 3) runs all of them concurrently via one
`Promise.all`, mirroring `getDashboardAnalytics`'s own concurrent-query
shape.

**Skipped** is a separate, third state (not "done", not "not started"),
and it is the one piece of real, persisted state per step (§9) — a step
a user explicitly skipped must never silently flip back to "not started"
just because a `count()` still returns zero, and must never look
identical to "done" (the UI distinguishes a checkmark from a
"skipped — dismiss" mark, §12).

Overall progress ("3 of 6") is just `steps.filter(s => s.status !== "not_started").length / steps.length` — a pure, unit-testable reduction over the per-step statuses this section already computed, no separate stored counter.

---

## 5. Steps, and the order

The example order given for evaluation was: Welcome, Create first Client,
Create first Project, Create first Task, Invite teammate, Invite Portal
User, Review Billing, Finish. Checked against §0.2's already-enforced
dependency chain and §0.3's existing invite flows, **that order is
correct, and this document adopts it unchanged** — it is not an arbitrary
suggestion, it is the order this codebase already enforces via
`clientCount`/`projectCount` gates on `/projects` and `/tasks`. The
reasoning for each transition:

1. **Welcome → Create first Client.** Nothing can be created before this
   except a Client (Client is the root of the dependency graph — §0.2's
   table has no "you need X first" row for it). Welcome itself is also
   the one natural place to offer renaming the auto-generated
   `"${user.name}'s Workspace"` org name (§0.4) — the first time that
   name has ever been surfaced as something a user might want to change,
   without inventing a whole Settings page to do it (§12).
2. **Client → Project.** Enforced today by `/projects`' own empty state
   ("You need a client first"). Onboarding surfaces the same fact one
   step earlier instead of waiting for the user to hit it.
3. **Project → Task.** Same reasoning, enforced by `/tasks`' own empty
   state.
4. **Task → Invite a teammate.** Deliberately *after* the "get your own
   data in" steps, not before: there is no dependency reason a teammate
   invite couldn't come earlier, but inviting someone into a completely
   empty workspace gives them nothing to look at either. "Set up your
   own house, then invite guests" is the framing, and it matches
   `Invoice` not being in this list at all (see below) — onboarding is
   about the *minimum* productive state, not every feature.
5. **Invite a teammate → Invite a Portal User.** Internal team first,
   external clients second — the same trust-boundary ordering `docs/
   comments-architecture.md` §0.3 already documents as this codebase's
   own existing split (flat internal access vs. a structurally separate,
   more cautious external identity). A Portal User invite also
   structurally requires a `Client` to already exist (§0.3) — already
   guaranteed true by step 2.
6. **Invite a Portal User → Review Billing.** Last of the "real" steps,
   deliberately: it's the one step about the *business relationship with
   this product itself*, not about using it — reviewing a plan only
   makes sense once there's a realistic sense of how the workspace will
   actually be used (team size, client count).
7. **Review Billing → Finish.** Always the last step, always reachable
   directly regardless of what's been skipped (§3).

**`Invoice` is deliberately not in this list**, even though it's a real
entity with its own dependency-gated empty state (§0.2). Reasoning:
Client and Project are structurally required for the product to mean
anything (everything hangs off them); Task demonstrates the "day to day
work" loop the product's own dashboard is built around (open/overdue
task KPIs). Invoice is a real, important, but *later* concern — sending
a first invoice happens once real work has actually happened, not on day
one. Including it would make onboarding longer without making the
workspace meaningfully more "ready." If real usage data ever contradicts
this, adding it is a pure additive step (§9's step-key set is designed to
grow, §20).

---

## 6. Required vs. skippable

Consistent with §0.5's "guidance, never a gate" finding: **no step is
ever blocking** — a user can navigate anywhere, including away from
onboarding entirely, at any point. "Required" here means something
narrower: whether a step gets an explicit, user-facing **Skip** button.

| Step | Skippable via an explicit "Skip"? | Reasoning |
|---|---|---|
| Welcome | No — but trivially dismissed by clicking "Next" (no real cost to acknowledging it) | Not a real decision to make |
| Create first Client | No | The one truly load-bearing step — see §1 |
| Create first Project | No | Same — but see below, this is soft |
| Create first Task | **Yes** | A user may legitimately want to explore Clients/Projects before creating a Task, or may manage tasks outside this product entirely |
| Invite a teammate | **Yes** | Solo use is a first-class, permanent, valid end state (§1) |
| Invite a Portal User | **Yes** | Not every freelancer/agency wants client-facing portal access enabled at all |
| Review Billing | **Yes** | Reviewing pricing is never mandatory (§16) |
| Finish | N/A — this action *is* the "I'm done" action | — |

"No explicit Skip button" for Client/Project does **not** mean blocking —
a user can still navigate to `/tasks` or anywhere else with zero Clients
in the system; they just won't see a "Skip" affordance offering to mark
that step as deliberately bypassed, because — per §1 — there's no
realistic scenario where a user of this product genuinely never wants a
single Client on the books. If that assumption turns out wrong for real
users, turning it into a skippable step later is a one-line change to
the step registry (§9), never a schema change.

---

## 7. Resume later

Resuming requires no special mechanism, by construction of §4/§9: since
per-step status is computed live from real data plus a small persisted
skip/dismiss table, **there is no "session" to resume** — a user who
creates a Client on Monday and comes back on Friday sees that step
already checked off, because the underlying `count()` query already
reflects it, the exact same way `/projects`' own empty state would.

What *is* explicitly designed for resuming:

- **Dismissing the checklist card** (a lightweight "hide for now," short
  of the full "Finish") hides it from `/dashboard` without touching any
  step's status — it reappears via the persistent Settings entry point
  (§12), never automatically again unless a step's data is later undone.
- **A step someone skipped stays skipped** until they explicitly go back
  and complete the underlying action (creating a Task, sending an
  invite) — completing the real action always overrides a prior skip
  (§9: the computed "done" check takes priority over a stored "skipped"
  row whenever both could apply), so nothing about skipping a step
  permanently blocks it from later showing as done.
- **A step someone "did" and then undid** (e.g. deleted their only
  Client) genuinely reverts to "not done" — see §9's explicit argument
  for why this is a feature, not a bug, of the computed-progress model.

---

## 8. Empty states — how onboarding and existing empty states coexist

They are two different layers solving two different problems, and
neither replaces the other:

- **`EmptyState`** (§0.2) is *local*: it answers "why is this specific
  list empty, and what's the one thing to do about it," rendered inline
  exactly where the emptiness is encountered. It has no memory, no
  concept of a multi-step journey, and needs none — it's already
  correct and this document changes zero lines of it.
- **The onboarding checklist** is *global*: it answers "what has this
  workspace done so far, across every area," rendered once, in one
  place (`/dashboard`, §12), independent of which page a user happens to
  be looking at.

Concretely: a brand-new user who ignores the dashboard checklist entirely
and clicks straight to `/projects` still sees "You need a client first" →
*Add client* — exactly as they would today, onboarding checklist or not.
The two are complementary, not layered redundantly (the checklist does
not duplicate the *reasoning* text, only points at the same destination
via its own step copy).

---

## 9. Where onboarding state lives

This is the question this stage was explicitly asked to argue hardest,
so every option gets a real hearing, not a foregone conclusion.

### Option A: Fully computed, no new storage at all

**What it would be:** every step, including Welcome/Finish, derived
purely from existing tables (e.g. Welcome = "has this org's OWNER's
`createdAt` ever been more than N seconds in the past," Finish = "are all
other steps done").

**Why it's rejected, not just "not chosen":** it almost works — §4
already computes five of eight steps this way — but breaks on exactly
the two things no query over business data can ever answer:

1. **Skip is not "not done yet."** A user who explicitly skips "Invite a
   teammate" and a user who simply hasn't gotten to it yet must render
   differently (§6) and must not re-prompt identically — nothing about
   the *absence* of a second Membership row can distinguish those two
   real, different facts.
2. **"Dismissed by choice" has no data trace.** An OWNER who explicitly
   hides the checklist with 2 of 6 steps still undone has made a real
   decision that must survive their next login — there is no
   business-data signal for "I chose to stop seeing this."

A purely computed system cannot represent user *intent*, only current
*state* — and §3/§6 both depend on intent.

### Option B: A JSON column (e.g. `Organization.onboardingState Json`)

**Why it's rejected:** this codebase has an explicit, on-point precedent
against it. `NotificationPreference`'s own schema comment: *"No JSON:
every channel is its own typed, non-nullable, defaulted boolean column,
so a query can filter on it directly instead of unpacking a blob."*
Onboarding's own skip/dismiss state is structurally identical to
`NotificationPreference`'s own problem (a small, fixed, per-scope set of
flags that need to be read and written individually, not as one opaque
document) — the same reasoning applies without modification. A JSON
column would also be the **first** of its kind in this entire schema for
"current queryable state" (every existing `Json` column — `Activity.metadata`,
`Notification.metadata` — is explicitly a write-once, never-filtered-on
audit *snapshot*, a genuinely different shape of problem, see Option D).

### Option C: A new, dedicated table

**What it is, concretely** — and the option this document adopts:

```prisma
// Proposed for Stage 2 (§20) — not applied in this stage.

enum OnboardingStepKey {
  WELCOME
  CREATE_CLIENT
  CREATE_PROJECT
  CREATE_TASK
  INVITE_TEAMMATE
  INVITE_PORTAL_USER
  REVIEW_BILLING
  FINISH
}

// One row = "a member of this organization explicitly skipped this step,
// or explicitly acknowledged a step with no business-data equivalent
// (WELCOME, FINISH)." No row = "still following the natural, computed
// default" (§4) — mirrors NotificationPreference's own "no row = default,
// a row only exists once someone deviates from it" model exactly, right
// down to never needing a backfill (a brand-new org simply has zero rows
// here on day one, the same way a brand-new user has zero
// NotificationPreference rows).
model OrganizationOnboardingStep {
  id String @id @default(uuid()) @db.Uuid

  organizationId String       @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  step OnboardingStepKey

  // Who actually clicked Skip/Acknowledge — informational only (e.g. "who
  // dismissed this"), never part of the authorization boundary (§13: any
  // current member may read/write this org's own rows regardless of whose
  // id is here).
  actedById String? @db.Uuid
  actedBy   User?   @relation(fields: [actedById], references: [id], onDelete: SetNull)

  createdAt DateTime @default(now())

  @@unique([organizationId, step])
}
```

**Why a whole table, not two booleans bolted onto `Organization`
directly** (the most likely alternative pushback, so it gets its own
answer): this mirrors `Comment`/`Mention`/`NotificationPreference`'s own
repeated, explicit precedent — a feature-specific concern gets its own
small additive table, never a widened core entity. Concretely:
`Organization` stays about *identity* (name, slug); a table scoped to
exactly the step keys this feature needs can grow (a future `skippedReason`
column, a future ninth step) without ever touching `Organization` again,
exactly the same "additive, not disruptive" property `docs/comments-
architecture.md` §2 argues for `CommentEntityType` over reusing
`ActivityEntityType`. A `String[]` array column on `Organization` was also
considered and rejected on a narrower, structural point: **no existing
model in this schema uses a native array column** for a multi-valued,
per-row-meaningful relationship — every single one (`Membership`,
`Invitation`, `NotificationPreference`, `Mention`, `CommentMention`) is a
separate table with a composite unique constraint, and this document
sees no reason for onboarding to be the first exception.

**Why per-`Organization`, not per-`Membership` (per-user):** stated as a
non-goal in §1, argued here. Almost every step (§4) is an objective fact
about the *organization's* data, independent of which member is looking
at it — a Client exists or it doesn't. Per-user tracking gets this
actively wrong for the one scenario that matters most: a second teammate
invited into an already-productive 50-client organization would, under
per-user tracking, see "create your first client" again, which is simply
false for that workspace. The one thing per-org tracking gives up — an
OWNER's personal "I've seen the welcome message" surviving independently
of a teammate's — is a small, acceptable simplification for the scale
this product targets (README: freelancers and small agencies), the same
scale reasoning `docs/notifications-architecture.md`'s own "Scale
expectations" section and `docs/billing-architecture.md`'s own plan
limits already lean on.

**Why no `completedAt`/`skippedAt` timestamp column, and no
`WELCOME`/`FINISH`-specific status enum:** row existence alone is the
entire signal needed (mirrors `Mention`'s own "exists = mentioned, full
stop" shape) — `createdAt` (already present on every model in this
schema) already answers "when," and a separate `status` column would
only ever hold one value per step given how §4/§6 partition which steps
can even produce a row here (only skippable/acknowledgment steps ever
get one; Client/Project/Task's "done" state never touches this table at
all — it's always computed).

### Option D: Reuse `Activity`

**Why it's rejected:** `Activity` is explicitly, permanently
append-only — *"Never updated or deleted by app code"* (its own schema
comment) — a historical record of what happened, read newest-first via
keyset pagination. Onboarding state is the opposite shape: small,
frequently re-read, **current**, and needs point lookups by
`(organizationId, step)`, not a chronological feed. Deriving "is step X
currently skipped" by scanning/replaying Activity rows on every dashboard
load would be strictly worse than Option C on every axis (query shape,
index shape, correctness under a hypothetical future Activity retention/
archival policy) for zero benefit — and this codebase already has a
directly on-point precedent for *not* doing this: `NotificationPreference`
is its own small table, not derived from replaying `Activity`, for
exactly this reason.

This does **not** mean onboarding and `Activity` have nothing to do with
each other — see §14: logging a *notable* onboarding milestone (finishing
the whole checklist) as one `Activity` row is a legitimate, separate,
optional decision, orthogonal to "where does current state live."

### Decision

**Hybrid: computed by default (Option A, for every step with a real
business-data signal) plus one small, additive table (Option C) for the
two things computation structurally cannot represent — an explicit skip,
and an explicit dismiss/acknowledge.** Nothing is stored redundantly:
the moment a skipped step's underlying action actually happens (a Task
gets created after "Create first Task" was skipped), the computed check
in §4 simply takes over — the stale `OrganizationOnboardingStep` row is
harmless, ignorable dead data, never cleaned up specially (the same
"stale rows are harmless, not actively pruned" stance
`docs/notifications-architecture.md`'s own retention section takes for
old, already-read notifications before its cleanup cron existed).

---

## 10. Progressive disclosure

The checklist shows **every step at once**, not one at a time behind a
"Next" gate — deliberately not a strict linear wizard, for two reasons:

1. **No existing precedent for a step-locked wizard exists in this app**
   (§0.5) to build on, and introducing one exclusively for onboarding
   would be a new, heavier interaction pattern for a product whose whole
   existing philosophy is "everything is one page, one form, one action."
2. **The steps are not uniformly a strict pipeline.** Client → Project →
   Task *is* strictly gated (§0.2, real data dependency) — but "Invite a
   teammate" has no dependency on "Create first Task" at all; a user who
   wants to bring in a collaborator immediately after creating their
   first Client should be able to, not be blocked behind an arbitrary
   step order a wizard would otherwise impose.

Disclosure instead comes from **visual state per row**, computed the
same way §4 already computes "done" — four states, never conveyed by
color alone (§0.5's "never color-only" rule):

- **Done** — a checkmark + label, e.g. "✓ First client added."
- **Available** — the default, actionable state, e.g. "Add your first
  project" with a real link/button.
- **Blocked** — grayed, with the *exact* existing empty-state reasoning
  as its own explanatory text (not new copy — reusing "Projects must
  belong to a client. Add one first." verbatim keeps the checklist and
  the empty state from ever disagreeing with each other), e.g. Task is
  Blocked until Project is Done.
- **Skipped** — a distinct, dismissable mark (not a checkmark) + a
  "Do this now" affordance to un-skip by actually doing it.

This is "progressive disclosure" in the sense that matters for this
product: a user only ever sees an actionable "next" affordance for steps
that are actually reachable right now, without a hard gate preventing
them from working on an *unblocked* step out of order.

---

## 11. UX — desktop and mobile

**Placement:** a single dismissible card/section at the **top** of
`/dashboard`, above the existing KPI grid (`src/app/(dashboard)/dashboard/page.tsx`)
— not a separate `/onboarding` route, and not a modal (§0.5). Rendering
it as part of the existing dashboard means it needs no new routing, no
new layout, and disappears the moment §3's completion condition is met,
the exact same conditional-rendering shape every `EmptyState` in this app
already uses (`{total === 0 ? <EmptyState .../> : <Table .../>}`).

**Why not a modal, restated concretely:** an automatic, unprompted modal
on first `/dashboard` load would be the first of its kind in this app
(§0.5) and is a real UX regression risk specifically for this product's
audience (a freelancer evaluating the tool for the first time does not
want their first click blocked by a dialog) — an inline, ignorable card
achieves the same goal (visibility) without the downside (interruption).

**Desktop:** the full checklist (§10's four-state rows) renders as a
bordered card, visually consistent with `MetricCard`'s own
`rounded-lg border border-gray-200 bg-white` treatment already used
throughout this dashboard — not a new visual language.

**Mobile (below `md:`, matching `Sidebar`'s own breakpoint — §0.5):** the
same component collapses to a compact summary strip ("Getting started —
3 of 6") that expands on tap, the identical "the same component adapts
its own layout at a breakpoint" philosophy `Sidebar` and the notification
dropdown already established — never a second, separately-maintained
mobile checklist component.

**Persistent entry point:** once dismissed (§7), a small "Getting
started" link lives in `/settings` (§0.4 — the first real addition to
Settings beyond notifications) so it's never truly lost, just no longer
in the way — mirroring how `/settings/notifications`' own
`ResetPreferencesButton` gives a user a durable way back to a default
state they've since moved away from.

---

## 12. Accessibility

- **Never color-only** (§0.5's existing rule, restated for this
  feature): Done/Available/Blocked/Skipped (§10) are each a distinct
  icon + text label, not a color alone — mirrors `StatusBadge`.
- **Heading structure:** the checklist card is its own labeled region
  (`aria-labelledby` pointing at its own heading, e.g. "Getting
  started"), consistent with every other dashboard section already using
  a real `<h2>`/`<h3>`.
- **Live region for progress changes:** completing a step while the
  card is open (e.g. creating a Client in one tab, returning to the
  dashboard tab) updates the "3 of 6" count — announced via the same
  `aria-live="polite"` pattern `toast-provider.tsx`/Search's result-count
  region already use, not a new mechanism.
- **Keyboard:** every row's primary action is a real `<Link>`/`<button>`,
  reachable and activatable by keyboard alone, same as every existing
  list-page action in this app (no custom key handling needed — there is
  no modal, no custom widget, so there is no focus-trap to build, §0.5).
- **Skip/dismiss actions** are real, labeled buttons ("Skip this step",
  "Hide for now") — never an icon-only affordance with no accessible
  name, matching this app's existing button-labeling discipline
  throughout (`DeleteButton`, `CancelInvitationButton`, etc. — every
  destructive/dismissive action in this codebase already has a real
  text label, not just an icon).

---

## 13. Security

- **Every read/write is org-scoped, server-resolved, exactly like
  everything else in this app.** `getOrganizationOnboardingState(organizationId)`
  and any skip/dismiss Server Action resolve `{ user, organizationId }`
  via `getCurrentUserOrganization()` (or `getCurrentMembership()` if role
  ever matters — see below) — **never** a client-supplied
  `organizationId`, the same non-negotiable rule every existing Server
  Action in this codebase already follows.
- **No role gate on skip/dismiss.** Per §0.3's own finding (via `docs/
  comments-architecture.md` §0.3): ordinary business content in this app
  has flat access (any Membership, any role) and role-gating is reserved
  for genuine trust/authority actions (Team management). Dismissing a UI
  nudge is closer to the former than the latter — no data is destroyed,
  no one's access changes, and the action is fully reversible (§7, §11's
  persistent entry point). The rejected alternative — restricting
  skip/dismiss to OWNER/ADMIN — was considered and dropped for adding a
  real permission check with no corresponding real risk to guard against.
- **No new information disclosure.** Every fact the checklist surfaces
  (client count, project count, member count) is already visible to any
  member of the org via the dashboard KPIs or the list pages themselves
  — onboarding computes nothing a member couldn't already see elsewhere.
- **`actedById` (§9) is informational only**, never an authorization
  check — any current member can un-skip/redo a step regardless of who
  originally skipped it, consistent with the flat-access decision above.
- **No PortalUser access.** `OrganizationOnboardingStep` and its queries
  are staff-only, reachable only through `/dashboard` and `/settings` —
  structurally unreachable from the Client Portal, the same "no route
  exists, not an explicit denied-check" shape every other staff-only
  feature in this app already has (§0.3, and see `docs/comments-
  architecture.md` §4's identical reasoning for Comments).
- **Rate limiting:** not warranted. Skip/dismiss actions are low-frequency,
  self-directed, single-organization mutations with no external side
  effect (no email, no third-party call) — the same reasoning already
  used elsewhere in this codebase to justify *not* rate-limiting a
  zero-side-effect action.

---

## 14. Activity

**No `Activity` row for individual step completion or skip.** Reasoning,
directly mirroring `docs/comments-architecture.md` §5's own "why only
`@mention` notifies, never 'someone commented'": `Activity` is already
generated by the *real* underlying action (`INVITATION_SENT` when a
teammate is invited, `CREATED` when a Client/Project/Task is made) —
logging a *second*, onboarding-specific Activity row for the same
underlying event would be pure duplication, not new information. An
org's Activity feed already answers "was a Client created and when";
it does not need to additionally know "...and this happened to also be
that org's first Client."

**One narrow exception, worth calling out rather than silently deciding
either way: finishing the whole checklist** (§3) is arguably a genuine,
new, notable organizational milestone with no other Activity trail — but
this document does not resolve whether it's worth a dedicated
`ActivityEntityType`/`ActivityAction` pair (both would need new, additive
enum values, out of scope for schema-touching in this stage) versus
simply not logging it at all. Recommendation, not a decision: **do not
add one in Stage 2** (§20) — ship without it, and revisit only if a real
future need for "which orgs have finished onboarding, and when" shows up
that the computed state (§9, trivially queryable: `dismissedAt IS NOT
NULL` equivalent via the `FINISH` row's `createdAt`) doesn't already
answer just as well.

---

## 15. Notifications

**No new `NotificationType`.** Checked against every existing type's own
justification (`docs/notifications-architecture.md` §2's classification,
and `NotificationType`'s own schema comment: *"a new type here should
mean a new fan-out rule is actually ready to ship, not 'this action
exists so it gets a Notification counterpart too'"*) — nothing about
onboarding progress is a "someone else did something you specifically
need to know about" event, which is the bar every existing type clears
(`ROLE_CHANGED`, `MEMBER_REMOVED`, `INVOICE_STATUS_CHANGED`, `MENTIONED`,
etc. all directly affect or name the recipient). "Your organization
finished onboarding" has no natural single recipient and no urgency —
whoever's looking at `/dashboard` already sees the checklist's own state
directly, in real time, with no delay a notification would improve on.

If a future stage wants to notify an OWNER that a newly-invited teammate
has "arrived" (their own Membership row created, satisfying the "Invite a
teammate" step) — that's already fully covered by the **existing**
`INVITATION_ACCEPTED` notification path (§0.3), which already fires
today, independent of anything this document adds. No new wiring needed.

---

## 16. Interaction with Billing

**Update (Sale-Ready Phase E):** `docs/billing-architecture.md`'s
Subscription/Entitlements system, referenced as "an unmerged branch"
when this section was originally written, has since been fully merged
and is live on `main` (Sale-Ready Phase E, E1–E2.6 — a real, resolver-
activated Paddle adapter now exists; see
`docs/billing-provider-adapter.md`). The rest of this section is kept
for historical context on the original design intent, with a correction
at the end for what's actually true today.

Per §0.6 (as originally written), `docs/billing-architecture.md`'s
Subscription/Entitlements system lived on an unmerged branch. This
document's "Review Billing" step was designed to degrade safely
regardless of merge order:

- **The step registry (§9's `OnboardingStepKey` enum) already includes
  `REVIEW_BILLING`** — adding it as inert was a zero-risk placeholder;
  removing an unused enum value later would be more disruptive than
  simply never rendering the step until it's meaningful.
- **The step was designed to be feature-detected at render time**, not
  schema-detected. What actually shipped is simpler than that original
  sketch: `isOnboardingStepAvailable()` (`src/lib/onboarding/steps.ts`)
  hardcodes `REVIEW_BILLING` as unavailable unconditionally
  (`return key !== "REVIEW_BILLING"`), by explicit design at the time
  ("don't pull the Billing branch in"), rather than actually importing
  and checking `getBillingProviderAvailability()`.
- **No dependency in the other direction.** Nothing in
  `docs/billing-architecture.md` needed to change, and nothing about
  billing's own entitlements/trial logic depends on onboarding existing.

**Current state (Sale-Ready Phase E, E3.3): `REVIEW_BILLING` is now
available.** `isOnboardingStepAvailable()` (`src/lib/onboarding/steps.ts`)
returns `true` unconditionally — the seam this section always said would
need to change, now flipped. The step's `targetHref` points at the real,
existing `/settings/billing` page (every staff role — OWNER/ADMIN/MEMBER
— can view it), and it stays `computed: false`, using the same explicit
acknowledgment/skip mechanism WELCOME/FINISH already use (via
`skipOnboardingStepAction`) rather than either of the two "done by data"
signals originally sketched above — both would either require a new
persisted visit-flag or leave the step permanently incomplete for any
organization without a real, successful Paddle checkout. The page itself
renders safely with no Paddle account configured at all
(`getBillingProviderAvailability()` reports `configured: false`; no
crash, no secret, no forced checkout) — reviewing billing has never
required setting it up. The onboarding checklist is now "Welcome →
Company Profile → Payment Details → Domain Setup → Client → Project →
Task → Invite teammate → Invite Portal User → Review billing → Finish."

---

## 17. Client Portal — deliberately thin

Per §0.1/§1's non-goals: a `PortalUser` can create nothing (no Client,
Project, Task, or invite flow reachable from `/portal` at all) — there is
structurally very little for a checklist to track. This document
recommends exactly one thing for the Portal side, not a parallel
onboarding system:

- **A one-time, dismissible "Welcome to your client portal" banner**,
  shown once on `/portal` (mirroring §11's own "inline, dismissible, never
  a modal" stance) the first time a `PortalUser` logs in — orienting them
  toward Projects/Invoices/Profile, nothing more. Whether this needs its
  own tiny persisted flag (a `PortalUser.welcomedAt DateTime?` column,
  the one place this document would consider a column directly on an
  existing model rather than a new table — because `PortalUser` is a
  single-purpose identity with no other feature-flag surface competing
  for the same space, unlike `Organization`) or can be inferred from
  `PortalUser.createdAt` being "recent" is left to Stage 2 (§20) to
  settle empirically against how "first login" is actually detected
  today (it currently isn't — there is no last-login timestamp anywhere
  in this schema).
- **Nothing else.** No checklist, no steps, no progress tracking — there
  is no real multi-step journey to disclose progressively for an
  identity that only ever reads.

---

## 18. Testing strategy

Mirrors this codebase's existing three-layer split exactly (§0.7).

### Unit (`test/unit/`)

- **Per-step status classifier** — a pure function taking already-fetched
  counts + already-fetched skip/dismiss rows and returning each step's
  Done/Available/Blocked/Skipped state (§10) — tested exhaustively: every
  step done, every step untouched, a mix, a step both "done" (real data
  exists) *and* previously "skipped" (done wins — §7), a step Blocked by
  its own dependency being merely Skipped rather than Done (does
  "Project skipped" still Block "Task"? — recommend yes, since Skipped
  Project genuinely means no Project exists, same as Available), the
  overall-progress fraction computation.
- **Billing step visibility** (§16) — the feature-detection predicate,
  tested for both "billing present" and "billing absent" inputs without
  needing the real billing module.
- **Step-order/dependency table** — a pure data structure, tested for
  internal consistency (every `Blocked` step names a real, existing
  prerequisite step key).

### Integration (`test/integration/onboarding/`, PGlite)

Mirroring `test/integration/notifications/dispatch.test.ts`'s and
Comments' own exhaustive style:

- `getOrganizationOnboardingState`: a fresh org with zero data returns
  all steps Available/Blocked correctly per §5's order; an org with
  real Clients/Projects/Tasks/a second Membership/a PortalUser returns
  the matching Done states, with **no** `OrganizationOnboardingStep` rows
  needed for any of them (proving Option A's computed steps never touch
  the new table at all).
- Skip/dismiss actions: create a row, `@@unique([organizationId, step])`
  prevents a duplicate, cross-org `organizationId` never matches another
  org's row, a `PortalUser` session has no reachable query/action at all.
- Un-skip-by-doing: a step marked Skipped, then its real underlying data
  is created (a Client added after "Create first Client" — note this one
  is never skippable per §6, so use a real skippable one, e.g. Task) →
  status flips to Done on the next read, the stale `OrganizationOnboardingStep`
  row is left in place untouched (§9's "harmless dead data" stance),
  verified explicitly so a future change doesn't accidentally start
  treating it as authoritative.
- A second Membership joining an already-productive org (seed a fixture
  org with existing Clients/Projects, then add a fresh Membership) sees
  the *org's* progress, not a reset one — the one test that most directly
  proves §9's org-scoped decision is correct in practice, not just in
  the document.
- Cascade: deleting an `Organization` cascades its `OrganizationOnboardingStep`
  rows (verified empirically against a real PGlite instance, the same
  "verified, not just asserted" discipline `docs/comments-architecture.md`
  §9 already used for its own cascade chain).

### E2E (`test/e2e/onboarding.spec.ts`)

- A brand-new signup (real flow, `TEST_MODE` identity injection) lands on
  `/dashboard` and sees the full six-step checklist (Billing absent,
  §16), Welcome first.
- Creating a Client through the real form flips that step to Done on
  return to `/dashboard`, with no separate onboarding-specific action
  ever called — proving the computed model end to end, not just at the
  integration layer.
- Skipping "Invite a teammate," then actually inviting one later, flips
  it to Done and the Skipped mark is gone.
- Dismissing the whole card hides it; the Settings entry point (§11)
  reopens it, still showing accurate state.
- A second, invited teammate joining an org that already has a Client
  and a Project sees those two steps already Done on first login — the
  one E2E scenario that most matters for catching a regression of §9's
  central design decision.
- A `PortalUser` session has no onboarding checklist reachable anywhere
  (mirrors the existing "Client Portal has no X" E2E pattern already
  used for Comments/Search/Notifications).

---

## 19. Migration strategy — zero regression

1. **One new enum, one new table, nothing else** (§9's Option C). No
   column is added to `Organization`, `Membership`, `User`, or any
   existing business entity — this feature is purely additive, the same
   "new tables/enums only" shape every recent feature in this codebase
   (Comments, Notifications' own later stages, Attachments) has already
   shipped without regressing anything that came before it.
2. **No backfill needed or possible.** A brand-new table starts empty;
   every *existing* organization simply has zero
   `OrganizationOnboardingStep` rows on day one, which — per §9's "no row
   = default" model — correctly means "nothing has been explicitly
   skipped or dismissed yet." This has a real, deliberate consequence
   worth stating plainly: **every organization that exists today would,
   the moment this ships, see the onboarding checklist appear** (most of
   them already fully "Done" by real data, per §4 — an established
   agency with 50 Clients would see a checklist that's already 4 or 5 of
   6 complete and trivially dismissible in one click). This is correct
   behavior, not a bug to design around, but Stage 4 (§20) should include
   an explicit one-time "if every real step is already Done on first
   render, auto-mark Finished rather than showing a checklist that's
   already fully green" convenience — a pure UI-layer decision, not a
   backfill.
3. **UI ships last**, once the computed-progress backend (§4/§9) has
   been proven correct against real data via integration tests — mirrors
   Comments'/Search's own "backend before UI" staging exactly (§20).
4. **Every existing test suite stays green throughout** — nothing this
   document proposes touches any existing query, index, constraint, or
   Server Action; the dependency-chain empty states (§0.2/§8) are read,
   never modified.

---

## 20. Roadmap — Stage 2 through Stage N

Mirroring Comments'/Search's own proven staging (§0's own citations) —
schema first, backend before UI, UI before audit, audit before
production:

- **Stage 2 — Schema.** The additive migration from §9/§19
  (`OnboardingStepKey`, `OrganizationOnboardingStep`), generated and
  verified against a disposable local PGlite instance only (never a
  shared/production database, matching every prior stage's own
  discipline) — no backend logic, no UI.
- **Stage 3 — Backend contract.** `getOrganizationOnboardingState(organizationId)`
  (§4/§9, the `Promise.all`-concurrent computed-status function), the
  skip/dismiss Server Actions (§9/§13), fully unit- and
  integration-tested (§18) — no UI yet, mirroring Comments Stage 2's and
  Search's own Stage 2's "schema/backend only" discipline.
- **Stage 4 — UI.** The dashboard checklist card (§11), its mobile
  collapse behavior, the Settings entry point (§0.4/§11), the
  already-fully-Done auto-finish convenience (§19 point 2), full E2E
  coverage (§18).
- **Stage 5 — Portal welcome banner** (§17) — small, independent, can
  land before or after Stage 4 with no ordering dependency on it.
- **Stage 6 — Billing step activation** (§16) — **done** (Sale-Ready
  Phase E, E3.3). `feature/billing-subscriptions`'s successor merged
  (E1–E2.6), and `isOnboardingStepAvailable()` was flipped to make
  `REVIEW_BILLING` available, pointing at the real `/settings/billing`
  page — see §16's own "Current state" note for the full behavior.
- **Stage 7 — Full audit & PR.** A comprehensive diff/security/regression
  audit in the same shape as the Comments/Search engagements' own final
  stages, ending in a PR (base `main`, head `feature/onboarding`) only
  once everything is green.
- **Stage 8 — Production verification.** Migration applied to the shared
  database, merge, and a real production smoke test with throwaway
  fixtures (a fresh signup, verified checklist state, explicit cleanup)
  — mirroring the Global Search engagement's own Stage 6 production
  verification pass.

No stage after this one (Stage 1) is started automatically — each is its
own explicit continuation, per this engagement's own standing
instruction.

---

## Stage 2 implementation note

Stage 2 (schema, progress engine, skip/dismiss backend contract — no UI,
no wizard, no dashboard change) implemented this document's design with
three deliberate refinements, made explicit here since each changes what
§9 originally proposed:

- **No `actedById`/`User` relation on `OrganizationOnboardingStep`.**
  §9 Option C's own illustrative snippet included one, described there as
  "informational only, never part of the authorization boundary." Stage
  2's own explicit instructions required no `User` FK on this table at
  all. Since nothing in this document's actual feature set (§1–§20) ever
  reads *who* skipped/dismissed a step — only whether the organization
  did — dropping it is a pure simplification with no loss of any
  described capability. Adding it back later, if a real need shows up, is
  a compatible, additive nullable column.
- **A `NOT_APPLICABLE` step status, alongside Done/Available/Blocked/
  Skipped.** §10's four UI-facing states didn't need a fifth for Stage 1's
  own purposes, but Stage 2's real backend contract needed a way to
  represent "this step is not currently offered at all" for
  `REVIEW_BILLING` on this branch (§16) without producing a false
  completion *or* a false "not started" signal — both of which would be
  misleading for a step nothing can act on yet. `NOT_APPLICABLE` steps are
  excluded from `totalCount`/`percent`/`requiredCompleted` entirely, never
  rendered as an actionable "next" item, and never writable by
  `skipOnboardingStepAction` (rejected explicitly, even though the
  catalog's own static metadata still marks `REVIEW_BILLING` as
  `skippable: true` for when it *does* become available).
- **An explicit, tested percent formula.** §4's own "3 of 6" example was
  illustrative, not a fully specified formula. Stage 2 settled it
  precisely, grounded in this document's own "six real steps" wording in
  §16: the denominator excludes `WELCOME` (a greeting, not an
  accomplishment) and excludes any `NOT_APPLICABLE` step, but **includes**
  `FINISH` — so on this branch (`REVIEW_BILLING` unavailable) the
  denominator is 6: Client, Project, Task, Invite teammate, Invite Portal
  User, Finish. `isComplete` (§3 path 1) is evaluated over a *different,
  narrower* set — the five/six substantive steps only, excluding both
  `WELCOME` and `FINISH` — so that reaching "nothing left to do" never
  depends on the user having formally clicked Finish, keeping §3's two
  completion paths genuinely independent as originally intended. Both
  sets, and every boundary between them, are unit-tested
  (`test/unit/onboarding-progress.test.ts`).

**Status as of Stage 2: computed backend + minimal persisted state, no
UI, independent of Billing.**
- `OrganizationOnboardingStep` (one new enum, one new table, purely
  additive — `prisma/migrations/20260907090000_add_onboarding_foundation/`)
  is real and migrated locally, never applied to any shared/production
  database.
- `getOrganizationOnboardingProgress()`/`getCurrentOrganizationOnboardingProgress()`
  and the three actions (`skipOnboardingStepAction`,
  `acknowledgeOnboardingWelcomeAction`, `finishOnboardingAction`) are real,
  fully unit- and integration-tested, and importable — but nothing in the
  app calls them yet. No dashboard card, no settings entry point, no
  route.
- `src/lib/onboarding/*` imports nothing from `src/lib/billing` and
  nothing from the Client Portal identity module — verified by
  `scripts/security-checks/check-onboarding-security.mjs`, not just
  asserted here.
- `REVIEW_BILLING` remains fully inert: excluded from every computed
  total, rejected by the skip action, and carries no real `targetHref` —
  see §16 for the seam Stage 6 fills in once `feature/billing-subscriptions`
  (or its successor) actually merges.

## Stage 4 implementation note

Stage 4 (Client Portal welcome experience) settles the one decision §17
explicitly left open — "a persisted flag ... or inferred from
`PortalUser.createdAt`, left to Stage 2 to settle empirically" — which
Stage 2 never actually touched (it scoped itself entirely to the staff
side). Stage 4 settles it in favor of the **zero-migration option**:

- **Eligibility is computed, not stored.** `isPortalWelcomeEligible(createdAt,
  now)` (`src/components/portal/portal-welcome-eligibility.ts`) is `true`
  while `now - createdAt` is under a 7-day window — no
  `PortalUser.welcomedAt` column, no new table, no migration at all.
  `PortalUser` is created exactly once, at `ClientInvitation`-accept time
  (`src/app/portal/invite/[token]/actions.ts`), and that accept flow
  redirects straight to `/portal` — so `createdAt` is a genuine "just
  onboarded" signal, not a guess. Seven days mirrors this codebase's own
  existing convention for `Invitation`/`ClientInvitation` validity
  (`expiresAt: now + 7 days`) rather than an arbitrary new number.
- **Dismiss is deliberately non-persistent.** Clicking "Got it"
  (`src/components/portal/portal-welcome-banner.tsx`) hides the banner via
  plain component state for the rest of that page instance only — no
  cookie, no column, no write of any kind. Returning to `/portal` later
  (a reload, a new tab, a new day within the 7-day window) shows it again.
  This is the explicit, accepted tradeoff of not adding persistence for a
  one-time nudge with no other feature-flag surface competing for the
  same space — the same reasoning §17 itself already applied to `PortalUser`
  when weighing a column against a new table.
- **CTA: "View projects" (primary) and "View invoices" (secondary) only —
  no "Complete profile."** `/portal/profile` is read-only by design ("a
  portal contact can never edit their own record" — its own page
  comment); a "Complete" CTA would imply an edit action that doesn't
  exist. Naming it accurately (e.g. "View profile") was passed over in
  favor of omitting a third CTA entirely, keeping to "real capabilities
  only," the same rule §5's own copy already follows.
- **No checklist, no steps, no progress — confirmed, not just carried
  over.** The banner is one static region: a heading, four factual bullets
  (view shared projects, review invoices, download files, manage your
  portal profile — all real, existing `/portal` capabilities), and the two
  CTAs above. It never reads `OrganizationOnboardingStep`, never imports
  `src/lib/onboarding`, and creates no `Activity`/`Notification` row —
  verified structurally by `scripts/security-checks/check-portal-welcome-security.mjs`,
  not just asserted here.
- **Placement: `/portal` (Portal home) only**, above the existing overview
  content, the same "ordinary part of the page, never a modal" stance §11
  already established for the staff Dashboard onboarding card. Every
  other Portal page (Projects, Invoices, Profile, login, invite-accept)
  is unaffected — no existing `EmptyState` usage was touched.

## Stage 5 implementation note

Stage 5 is a no-new-capability audit pass (polish, accessibility,
performance, security, consistency, maintainability) across both Stages
3 and 4's UI. No schema, no route, no step, no CTA, no new persisted
state — `git diff prisma/` stayed empty throughout, same as Stage 4.

Real findings fixed:

- **Focus was silently dropped to `<body>` after Skip and Dismiss.**
  Neither `SkipStepButton` nor the staff `DismissOnboardingButton` moved
  focus anywhere once their own element unmounted (a row's Skip button
  disappearing once `SKIPPED`; the whole card disappearing once
  dismissed) — the Portal welcome banner's own dismiss already did this
  correctly (§17's own Stage 4 note), the staff side didn't. Fixed by
  giving each step row's label a stable, focusable id and the Dashboard
  page's own `<h1>` a stable id (`ONBOARDING_DISMISS_RETURN_FOCUS_ID`,
  exported from `onboarding-card.tsx` so the two call sites can't drift
  out of sync), and moving focus there on a successful skip/dismiss —
  the same pattern the Portal banner already established, now applied
  consistently on both sides.
- **Blocked rows computed `isBlocked` but never used it visually.** §10's
  own "Blocked — grayed" state wasn't fully implemented — a blocked row
  read identically to an actionable one except for its description text.
  Fixed with a plain `opacity-60` on the row's icon+label (never the only
  signal — the description text and the absent action buttons already
  carry the actual meaning).
- **`aria-valuetext` was missing from the progress bar.** Screen readers
  announced a bare percent; added `"N of M complete"` so the announcement
  matches what's visually shown next to the bar.
- **A very long Client name had no overflow protection.** The Portal
  overview page's own `<h1>{client.name}</h1>` (unbounded user text) had
  no `break-words` — added, matching an existing pattern already used
  elsewhere in this app (`grep -rl truncate\|break-words src/` returns 9
  files).
- **`OnboardingStepIcon` repeated the same `<svg>` shell four times.**
  Deduplicated into one shell with a per-status color/glyph lookup —
  identical rendered output, verified by the unchanged E2E suite.

Considered and deliberately left unchanged, to avoid regressing
consistency with the rest of the app:

- **No shared `useTransition`+toast hook for Skip/Dismiss.** The
  duplication is real (2 call sites) but extracting a hook used only by
  onboarding, while `ResetPreferencesButton`/`NotificationDropdown`
  elsewhere in the app keep hand-rolling the identical pattern, would
  make onboarding *less* consistent with the rest of the codebase, not
  more.
- **No `prefers-reduced-motion` handling.** Zero precedent anywhere in
  this app (`grep -rn prefers-reduced-motion src/` returns nothing) —
  adding it only for onboarding's own `transition-colors`/`transition-
  [width]` would be a new, isolated pattern, not a fix to a regression.
- **`OnboardingActionResult` (actions.ts) is exported but never
  explicitly imported by name.** Every call site relies on TS inference
  instead — the same shape every other Server Action's own result type
  takes in this codebase. Not dead code; left as-is.
