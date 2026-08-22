# Comments & Mentions — Architecture & Design (Stage 1)

Design-only. No code, no migration, no fan-out wiring in this stage —
exactly the discipline the Notifications Center followed in its own
Stage 1 (`docs/notifications-architecture.md`), which this document
extends rather than duplicates. Where a decision here reuses an existing
mechanism verbatim, that mechanism is named, not re-explained.

---

## 0. Grounding: what already exists

Read before writing a line of this doc — the decisions below are only
justified because they follow precedent that's already shipped and
proven in this codebase, not because they're the only reasonable design.

### 0.1 The precedent this doc leans on hardest

`docs/notifications-architecture.md` §7 already sketched Comments and
Mentions as a "zero schema change needed" future extension:

> **Comments**: a future `Comment` model's create action calls
> `createActivity()` (a new `entityType: COMMENT`, `action: CREATED`)
> exactly like every existing entity... **Mentions**: a `@mention` inside
> a comment/note body is detected at write time... produces its own
> `Notification` row with `activityId` pointing at the comment's Activity
> row and `metadata: { mentionedUserId }`.

That sketch is directionally correct and this design keeps its core
claim (no changes to `recipientId`, the notify-vs-never classification,
or the read-model queries — see §5 there). It was written before a
concrete `Comment` model existed, though, so it under-specifies exactly
the questions this stage has to answer: what happens with more than one
mention per comment, what an *invalid* mention looks like, whether an
edit re-fires anything, what a deleted comment renders as. Consider this
document the full version of that one paragraph.

### 0.2 The polymorphic-target precedent, and that it's not universal

Three tables already attach content to "some entity" without a foreign
key to it, and each scopes its own enum narrower than the last:

- `Activity.entityType`: `ActivityEntityType` — 8 values (CLIENT,
  PROJECT, TASK, INVOICE, MEMBERSHIP, INVITATION, ATTACHMENT,
  PORTAL_USER). The broadest, because Activity is a genuine audit log of
  everything.
- `Attachment.entityType`: `AttachmentEntityType` — only 3 values
  (CLIENT, PROJECT, INVOICE). Notably **no TASK** — Tasks have no file
  attachments today, a real product gap, not an oversight of this
  design.
- `Notification.entityType`/`entityId`: reuses `ActivityEntityType`
  directly (nullable, since not every Notification traces to one entity
  — e.g. a future due-date reminder wouldn't).

None of the three use a real foreign key: `entityId` is a plain
`String @db.Uuid` in every case, checked at read time, never enforced by
Postgres. That's deliberate everywhere it appears — the referenced
Client/Project/Task/Invoice can be deleted later without orphaning or
cascading the audit/attachment/notification row that mentions it (see
Activity's own comment: "Activity.entityId is not a foreign key... this
row (and its metadata) is what keeps the entry readable once the
\[parent\] row itself is gone").

Every one of these tables also **denormalizes `organizationId` directly
onto itself**, rather than resolving it by joining through the parent
entity at read time. This is what makes `@@index([organizationId,
entityType, entityId, createdAt, id])` — identical on Activity and
Attachment — a real, cheap, tenant-safe index instead of a join.

Comments follow this exact precedent: their own `CommentEntityType` enum
(§2), a plain `entityId` (no FK), and a denormalized `organizationId`.

### 0.3 The authorization model comments actually inherit

`src/lib/current-user.ts` is the only place identity/org context is
resolved, via two functions:

- `getCurrentUserOrganization()` → `{ user, organizationId }` — the
  organization is the user's own explicit choice (an httpOnly cookie),
  verified against a real `Membership` row on every call, never trusted
  bare. Used by the large majority of Server Actions (Client, Project,
  Task, Invoice CRUD).
- `getCurrentMembership()` → adds `{ membership }` (with `.role`) — used
  only where behavior actually varies by role.

Checking every current `createActivity()` call site (§0.4) confirms
something that matters a lot for §4: **Client, Project, Task, and
Invoice CRUD have no role gate at all.** `deleteProjectAction`,
`deleteTaskAction`, `updateProjectAction` etc. all resolve
`{ user, organizationId }` and scope every query by
`{ id, organizationId }` (or, for Task, `{ id, project: { organizationId
} }`) — any Membership, regardless of role, can create/edit/delete any
Client/Project/Task/Invoice in their active org. The **only** place role
matters today is Team management: `inviteMemberAction` requires
OWNER/ADMIN, `changeRoleAction` requires OWNER. That split — flat access
for ordinary business content, role-gated only for membership/trust
actions — is a real, considered product decision already in this
codebase, and §4 follows it rather than inventing a third policy.

### 0.4 Every `createActivity()` call site today (30 total)

Enumerated exhaustively (not sampled) because §5's "which comments
generate Activity" reasoning depends on matching this existing
discipline precisely, not approximating it:

`clients/actions.ts`, `clients/new/actions.ts`,
`clients/[id]/edit/actions.ts`, `clients/[id]/edit/portal-access-actions.ts`
(×4 — send/resend/cancel/accept a portal invite, remove a portal user),
`projects/actions.ts`, `projects/new/actions.ts`,
`projects/[id]/edit/actions.ts` (×2 — STATUS_CHANGED and UPDATED are
always split into separate Activity rows, never combined), `tasks/actions.ts`,
`tasks/new/actions.ts`, `tasks/[id]/edit/actions.ts` (×2, same split),
`invoices/actions.ts`, `invoices/new/actions.ts`,
`invoices/[id]/edit/actions.ts` (×2), `team/actions.ts` (×7 — invite,
resend, cancel, role change ×2 branches, remove, leave),
`invite/[token]/actions.ts`, `portal/invite/[token]/actions.ts`,
`attachments/attachment-mutations.ts` (×3 — upload, delete single, bulk
delete-for-parent).

Every single one is called from inside a `prisma.$transaction(...)`
alongside the business mutation it records — never after, never from a
Route Handler, never with a bare `prisma` client. This is the one
absolute rule Comments must inherit unchanged: **a Comment insert (and
any Activity/Notification it produces) is one atomic transaction with
nothing else**, so there's no "business mutation" to be atomic *with* —
the comment *is* the mutation.

### 0.5 The notification pipeline's exact extension point

`src/lib/notifications/notification-rules.ts` keys a `RULES` table by
`(entityType, action)`, each entry a `{ type, resolveRecipients,
buildMetadata }`. `dispatch-notifications.ts` — called automatically
from inside `createActivity()` for **every** Activity, no per-caller
opt-in — looks up the rule (a no-op if none exists), resolves candidate
recipients, then applies three things uniformly, once, regardless of
which rule fired:

1. **Actor exclusion**: `.filter((id) => id !== activity.actorId)`.
2. **Dedup**: `[...new Set(candidates)]`.
3. **Existence check**: a `User.findMany` before insert, so a
   recipient id that no longer resolves to a real row is a silent no-op,
   never a foreign-key error that would roll back the transaction.

Critically for §3: **existence-check today means "does this User row
exist anywhere," not "is this User a member of this organization."**
Every current rule's candidate ids are themselves derived from a
Membership query or from `NotificationContext` (server-computed,
trusted values — an inviter id, an affected member id) — never from
free-form content a user typed. Mentions are the **first** notification
source whose recipient candidates come from parsing something a user
wrote, which is exactly why §3 and §8 both call out that the existing
existence-check is not sufficient on its own for mentions and needs an
explicit org-membership filter added alongside it.

### 0.5 Portal boundaries, precisely

`PortalUser` is deliberately not a variant of `User` — no Membership,
never resolved by `getCurrentUserOrganization()`, reached only through
`getCurrentPortalUser()`/`getPortalProject(clientId, id)`-style
clientId-scoped queries (`src/lib/current-portal-user.ts`,
`src/lib/client-portal/queries.ts`). Concretely, as of this stage:

- The portal renders `/portal/(app)/projects/[id]` — a read-only Project
  summary (name, status, dates, client name) plus an Attachments list.
  **No Tasks appear anywhere in the portal** — there is no
  `portal/(app)/tasks` route at all.
- There is no portal Settings, no portal notification bell, no portal
  Activity feed. Every one of those is staff-only by omission (no route
  exists), not by an explicit denied-check.

This means: Task comments have **zero** portal exposure to design for —
there's no page to put them on. Project comments are the only place a
PortalUser-visibility question is even reachable, and §4 resolves it in
the same direction as every other staff-only feature in this app.

### 0.6 What's genuinely new here vs. reused verbatim

Reused verbatim: `createActivity()`'s transaction discipline, the
`(entityType, action)` rule-table shape, actor-exclusion/dedup, the
keyset cursor helper (`src/lib/activity/cursor.ts`, base64url `{createdAt,
id}`, malformed → "start over"), `NotificationPreference`'s lazy-row/
default-true/reset-deletes-rows model, the shared-component-with-bound-
actions pattern (`AttachmentsSection`), the security-check suite's `no
dangerouslySetInnerHTML` invariant.

Genuinely new: a recipient set computed from user-authored text instead
of server-derived relations (mentions), which is why §3 and §8 spend the
most words in this document — it's the one place precedent alone doesn't
already answer the question.

---

## 1. Goals and non-goals

### Goals

- Let staff leave threaded-free (not threaded, see §6) text comments on
  a Project or a Task, visible to every member of the owning
  organization.
- Let a comment `@mention` another org member and have that produce
  exactly one Notification (and, per the existing email allowlist logic,
  one email) for each person actually mentioned — no more, no less.
- Reuse every existing mechanism this codebase already has for "record
  an event, maybe notify someone about it" rather than building a
  parallel system: Activity, the notification rule table,
  NotificationPreference, the email formatter/allowlist, the keyset
  cursor, the rate limiter.
- Ship additively: no existing table, column, enum value, or query
  changes meaning; Comments is purely new tables + new enum values + new
  rule-table entries, mirroring exactly how Notifications itself was
  introduced without touching Activity's existing behavior.

### Non-goals (this stage, and likely several stages beyond it)

- **Threading/replies.** Flat, chronological comments only. §2 leaves a
  documented, additive extension point (`parentCommentId`) but does not
  build it.
- **Rich text / Markdown rendering.** Plain text only — see §8 for why
  this is a security decision, not a laziness one.
- **File attachments on comments.** Additive future extension (§2), not
  built here.
- **Emoji reactions.** Additive future extension (§2), not built here.
- **Client Portal comment access, in either direction.** No PortalUser
  can read, write, or be mentioned in a comment in this design. See §4
  for the full reasoning — this is the single most consequential
  non-goal in this document, because reversing it later is a real
  content-moderation project, not a follow-up migration.
- **Realtime.** No websockets, no polling, no "someone is typing" —
  identical stance to the Notifications Center's own explicit non-goal
  through all 8 of its stages.
- **A due-date-style "everyone on this project gets pinged for every
  comment" ambient notification.** Only explicit `@mention` notifies
  anyone (§5) — deliberately more conservative than some PM tools
  (GitHub notifies thread participants by default; this design does
  not), matching this app's own established MVP conservatism (six
  notification types total, chosen narrowly — see the Notification
  model's own schema comment on why NotificationType isn't
  one-to-one with ActivityAction).
- **Full edit-history / version log.** See §2 — a single `editedAt`
  marker, not a `CommentRevision` table, for the same reason Project/
  Task edits get a changed-field list, not a stored diff.

---

## 2. Data model

```prisma
enum CommentEntityType {
  PROJECT
  TASK
}

model Comment {
  id String @id @default(uuid()) @db.Uuid

  organizationId String       @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  entityType CommentEntityType
  entityId   String            @db.Uuid

  // Nullable + SetNull, identical reasoning to Activity.actorId: no
  // action deletes a User today, but if that ever changes, a comment
  // shouldn't vanish (or block the delete) just because of who wrote it.
  authorId String? @db.Uuid
  author   User?   @relation("CommentAuthor", fields: [authorId], references: [id], onDelete: SetNull)

  // Plain text only (§8) — may contain zero or more embedded mention
  // tokens in the form @[Display Name](user:<uuid>), written only by the
  // composer's own autocomplete, never hand-typed and trusted (§3).
  body String

  editedAt  DateTime?
  deletedAt DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  mentions Mention[]

  // Mirrors Activity/Attachment's exact composite shape — org first, so
  // a foreign entityId can never be queried across tenants; createdAt+id
  // for a stable, gapless keyset cursor (§7).
  @@index([organizationId, entityType, entityId, createdAt, id])
  @@index([organizationId, createdAt, id])
}

model Mention {
  id String @id @default(uuid()) @db.Uuid

  commentId String  @db.Uuid
  comment   Comment @relation(fields: [commentId], references: [id], onDelete: Cascade)

  // Not SetNull: a Mention with no resolvable user is meaningless (it
  // exists only to answer "who was mentioned"), so it's deleted along
  // with the User row, same reasoning as NotificationPreference.userId.
  // It deliberately does NOT cascade on Membership removal — a mention
  // is a historical fact about who was tagged at the time, exactly like
  // Activity.actorId surviving after its actor later leaves the org.
  mentionedUserId String @db.Uuid
  mentionedUser   User   @relation(fields: [mentionedUserId], references: [id], onDelete: Cascade)

  createdAt DateTime @default(now())

  // The duplicate-mention guarantee (§3) as a database constraint, not
  // just parse-time dedup — belt and suspenders, the same discipline
  // NotificationDelivery's @@unique([notificationId, channel]) already
  // demonstrates for a different table.
  @@unique([commentId, mentionedUserId])
  // Future "comments that mention me" view — not built this stage, but
  // free to add now, same reasoning as Attachment's unused-today index.
  @@index([mentionedUserId, createdAt])
}
```

### Decisions, one at a time

**Project comments vs. Task comments: one polymorphic model, not two
tables.** A `ProjectComment`/`TaskComment` split would duplicate every
column, every query, every Server Action, and every test twice for zero
behavioral difference between the two — Attachment already proves this
codebase's answer to "does every entity type get its own table" is no.
`CommentEntityType` is its own enum (not a reuse of
`ActivityEntityType`/`AttachmentEntityType`) because, per §0.2, no
existing enum is used verbatim by two different features — each narrows
to exactly what it supports, and Comments supports exactly {PROJECT,
TASK}, nothing else.

**Polymorphic target vs. real foreign keys.** Polymorphic (`entityType`
+ plain `entityId`), for the same reason Activity/Attachment/Notification
all are: a Project or Task can be deleted (both already cascade-delete
their own children today — see §10 for what that means for Comments
specifically) without needing Comment's own FK constraints to
participate in that cascade chain. Postgres CASCADE via a real FK would
actually work fine here too (Comment.entityId *could* be a real FK to
Project OR Task, if this were a single-entity-type feature) — but a
polymorphic column can never be a single FK to two different tables at
once, so the precedent and the practical two-target requirement point
the same direction.

**Author model.** `authorId` is a single nullable FK to `User` —
deliberately **not** to `PortalUser`, and deliberately not two nullable
columns the way an early Notification draft briefly considered before
settling on User-only. Per §0.5/§4, no PortalUser can create a comment in
this design, so a `authorPortalUserId` column would be dead weight from
day one. If Client-visible comments ever ship, the correct extension
(mirroring how Notification's own header comment already documents this
exact tradeoff for its `recipientId`) is a new nullable
`authorPortalUserId` column added in its own additive migration — never
repurposing `authorId` to mean two different identity types.

**Edit history: a timestamp marker, not a version table.** `editedAt:
DateTime?` (null = never edited) is the entire mechanism — the UI shows
"(edited)" next to a timestamp, nothing more. A full `CommentRevision`
table storing every prior body would be over-engineering for what this
product actually needs: Project/Task edits themselves only ever produce
a changed-*field-names* Activity entry (see `diffProjectFields`), never
a stored diff or previous value, and Comments shouldn't hold itself to a
stricter audit standard than the entities it's commenting on. If a real
compliance/audit requirement shows up later, a `CommentRevision(id,
commentId, body, createdAt)` table is a pure, additive bolt-on — nothing
about the `Comment` row itself needs to change to support it.

**Soft delete, not hard delete — the one place Comments deliberately
differs from Activity/Notification's own precedent.** Both of those are
either fully immutable (Activity) or hard-deleted later by a batch
retention job (Notification, §"Cleanup strategy" in the Notifications
doc). Comments need soft delete instead, for a reason specific to this
feature: a deleted comment can already be the subject of a Notification
("X mentioned you") that a recipient may open well after the comment is
gone, and — even without threading built yet — a comment sitting in the
middle of a chronological list simply vanishing reads as confusing or
alarming ("did someone remove evidence?") in a way an Activity log entry
disappearing wouldn't (Activity is never displayed as a conversation).
Mechanism: `deletedAt: DateTime?`; on delete, the Server Action clears
`body` to an empty string (the content itself is genuinely gone — a
user who deletes something they regret typing should have it actually
gone, not just hidden) and sets `deletedAt`; the read query still
returns the row, and the UI renders a fixed "This comment was deleted"
placeholder instead of the (now-empty) body whenever `deletedAt` is set.
`Mention` rows for a soft-deleted comment are left untouched — the
Notification they already produced remains meaningful and accurate
("X mentioned you" stays true even if the comment is later deleted;
retracting it would be a different, unrequested product decision).

**Future attachments.** Not built. When it is: a new
`AttachmentEntityType.COMMENT` value (additive `ALTER TYPE ADD VALUE`) —
the existing `Attachment` table, upload/delete Server Actions, and
Storage bucket wiring all already work unmodified for a new entity type,
exactly as they did nothing special to support PROJECT vs. INVOICE
today. No new table.

**Future emoji reactions.** Not built. When it is: a new
`CommentReaction(id, commentId, userId, emoji, createdAt)` table with
`@@unique([commentId, userId, emoji])` (one person can't double-react
with the same emoji — mirrors `Mention`'s own duplicate guarantee
exactly) is a pure additive table; nothing on `Comment` changes.

---

## 3. Mentions

### Mention syntax: a structured token, not free-text `@name` parsing

Free-text `@Jane` parsing against a display-name lookup is the obvious
first idea and the wrong one: names collide ("Jane Doe" and "Jane
Smith" both start with "Jane"), contain spaces (where does the mention
end?), and change (a renamed User silently breaks every historical
mention if names are the join key). Instead:

- The **composer** is the only thing that ever writes a mention. Typing
  `@` opens an autocomplete populated from the current organization's
  real `Membership` list (a client-side fetch of `{id, name}` pairs,
  already-known org-scoped data — no new query pattern). Picking someone
  inserts a literal token into the textarea's value:
  `@[Jane Doe](user:3f9e2b41-...)`.
- The **stored** `Comment.body` keeps that exact token as part of the
  plain text.
- The **rendered** output (both in-app and email) parses `@[([^\]]+)]\
  (user:([0-9a-f-]{36})\)` out of the body and replaces each match with
  a fixed `<MentionTag>`-style component showing `@Jane Doe` — never the
  raw token — styled distinctly from ordinary text. This parse-and-
  replace step is the *only* thing that ever touches raw mention syntax;
  it is a fixed regex over a fixed shape, not a general markdown parser
  (see §8 for why that distinction matters).

This is the same "structured, autocomplete-only, never hand-typed-and-
trusted" pattern several mainstream tools (Trello, Notion, Linear) use
for exactly this reason, and it sidesteps name-collision and rename
problems entirely because the token carries the real, permanent user id,
never the display name, as its source of truth.

### Mention parsing (server-side, at write time)

The client-inserted token is a UX convenience, never a trust boundary —
identical philosophy to how this app already treats every client
`<select>` (e.g. `updateProjectAction`'s own comment: "the invite form
is only ever rendered for OWNER/ADMIN, but a request can be crafted
directly, so re-check here"). The comment-create Server Action:

1. Extracts every `user:<uuid>` token from the submitted `body` via the
   fixed regex above.
2. Dedupes by uuid (`[...new Set(...)]` — identical to
   `dispatch-notifications.ts`'s own dedup line).
3. Excludes the author's own id (you mentioning yourself notifies no
   one — same actor-exclusion rule every other notification type
   already gets for free from `dispatch-notifications.ts`, applied here
   explicitly before that shared function ever runs, since a mention's
   "recipients" are Comment-specific, not activity-actor-generic).
4. **Validates each remaining id against a real, current `Membership` row
   in the comment's own `organizationId`** — not just `User` existence.
   This is the one genuinely new validation this feature adds to the
   pipeline (§0.5): every other current notification type's candidate
   ids are already guaranteed org-scoped by construction (they come from
   a Membership query or a same-org relation); a mention's candidate ids
   come from parsing user-authored text, so nothing guarantees the
   embedded uuid is even a real user, let alone a member of this
   organization, until this step checks it.
5. Whatever survives becomes both: (a) the `Mention` rows persisted
   alongside the `Comment` in the same transaction, and (b) the
   recipient list `dispatch-notifications.ts` and a new `MENTIONED` rule
   in `notification-rules.ts` use to fan out (§5) — the rule's
   `resolveRecipients` for `MENTIONED` simply returns this
   already-validated list, so the rule table's own actor-exclusion/dedup
   pass is redundant-but-harmless here, not load-bearing (defense in
   depth, matching how `shouldDeliverNotificationEmail`'s own existing-
   delivery check is redundant-but-harmless for a request that already
   passed one earlier gate).

### Duplicate mentions

Handled twice, deliberately: parse-time dedup (step 2 above, so
`@[Jane](user:X) ... @[Jane](user:X)` in one comment produces exactly
one Notification, not two) *and* `Mention`'s own
`@@unique([commentId, mentionedUserId])` constraint, so even a future
code path that forgets the parse-time dedup fails loudly (a constraint
violation) rather than silently double-inserting — the same
belt-and-suspenders relationship `NotificationDelivery`'s unique
constraint already has with `shouldDeliverNotificationEmail`'s own
already-resolved check.

### Invalid mentions

A token whose uuid doesn't parse as a UUID, doesn't resolve to a real
`User`, or doesn't resolve to a **current member of this organization**
is simply not a mention: it produces no `Mention` row and no
notification, and — critically — it is **rendered as plain literal
text**, not as a broken `<MentionTag>` or an error. This mirrors
`resolveNotificationLinkPath`'s own stated philosophy exactly: "no link
is safer than a broken one." A comment containing `@[Someone](user:not-
a-uuid)` (hand-typed, never produced by the real composer) just displays
that literal string.

### Deleted users

If a mentioned `User` is later deleted (no path does this today, but
`Mention.mentionedUserId` cascades on User delete per §2), the `Mention`
row disappears with it — same reasoning as `NotificationPreference`.
The `Notification` row the mention already produced is untouched (it has
its own independent `recipientId`, already resolved and stored at
fan-out time — deleting the `Mention` audit row later doesn't retract a
notification that already happened). If a mentioned user is removed from
the *organization* (Membership deleted, User row intact), the `Mention`
row is deliberately left alone (§2) — it's a historical record, and the
rendered `@Jane Doe` tag continues to resolve and display normally,
exactly like Activity entries about people who've since left.

### Cross-org validation

Covered by step 4 above as the primary mechanism, but stated explicitly
because it's the single most important security property in this
document: **a mention notification (and its email) is only ever created
for a user with a current `Membership` in the exact `organizationId` the
comment belongs to.** Without this check, a malicious or careless
comment author could embed an arbitrary `user:<uuid>` — harvested,
guessed, or enumerated — and either (a) spam a stranger with an email
notification they never asked for, or (b) probe whether a given uuid
corresponds to a real `User` at all (an information leak, since a
notification firing vs. not firing is an observable signal). §8 restates
this as a rate-limiting and abuse concern, not just a correctness one.

---

## 4. Permissions

Comments follow §0.3's existing split (flat access for ordinary
business content, role-gated only for a trust/moderation action) rather
than inventing a third policy:

| Action | OWNER | ADMIN | MEMBER | PortalUser |
|---|---|---|---|---|
| View comments on a Project/Task they can already see | ✅ | ✅ | ✅ | ❌ |
| Create a comment | ✅ | ✅ | ✅ | ❌ |
| Edit **their own** comment | ✅ | ✅ | ✅ | ❌ |
| Edit **someone else's** comment | ❌ | ❌ | ❌ | ❌ |
| Delete **their own** comment | ✅ | ✅ | ✅ | ❌ |
| Delete **someone else's** comment (moderation) | ✅ | ✅ | ❌ | ❌ |
| Be `@mentioned` | ✅ | ✅ | ✅ | ❌ |

**View/create: flat, matching Client/Project/Task/Invoice exactly.**
Comments aren't a separately-gated resource — if a Membership can already
see (and freely edit/delete) the Project or Task itself, per §0.3 there
is no existing precedent for gating a *sub-resource* of it more tightly
by role. Inventing a stricter rule here (e.g. "only ADMIN+ can comment")
would be a new policy this codebase doesn't have anywhere else, not a
continuation of one.

**Edit: author-only, no role override.** Nobody — not even OWNER — can
edit someone else's comment text. This is a content-integrity rule, not
an access rule: the concern isn't "can they see it," it's "whose words
are these." No time-limited edit window in this design (edit is allowed
indefinitely); a window is a plausible future refinement, not a launch
requirement.

**Delete-any (moderation): OWNER/ADMIN only, deliberately following the
Team-management precedent instead of the flat Client/Project/Task
one.** This is the one place this document adds a role gate this
codebase doesn't already have for "regular" business content, so it's
worth stating why explicitly: removing *someone else's words* is closer
in kind to a trust/authority action (mirroring `changeRoleAction`/
`inviteMemberAction`'s own OWNER/ADMIN gate) than to routine data editing
(mirroring the flat Project/Task delete). A MEMBER who could delete any
other member's comment has no real product justification and a real
abuse one (silencing a colleague); an OWNER/ADMIN who can is ordinary,
expected moderation capability, the same shape Team management already
grants them elsewhere.

**PortalUser: nothing, in every column.** No view, no create, no
mention-target. This is the largest single scope decision in this
document, so it gets its own justification, not just a table row:

1. **Structurally, there's nowhere to put it today.** Per §0.6, the
   portal's Project detail page shows a read-only summary + Attachments;
   there is no Task page in the portal at all. Task comments have zero
   portal surface to reach even if this decision went the other way.
2. **It's consistent with every other staff-only feature already
   shipped.** Notifications, preferences, Team, Activity — none of them
   have any portal exposure, not because they were deliberately blocked
   for clients but because they were never built for that identity at
   all. Comments joining that list is the default, not an exception.
3. **The real reason to hold the line, though, is that "client-visible
   comments" is a genuinely different, harder feature** — it needs an
   explicit internal-vs-client-visible flag (or a second, deliberately
   separate table) and a real content-moderation boundary: today, a
   comment's author trusts every other reader to be a co-worker in the
   same organization; a portal-visible comment thread means staff must
   actively decide, per message, whether a client should see it. That's
   not a permissions checkbox, it's a product/trust design of its own,
   and folding it into this stage would be exactly the kind of
   scope-creep this document's own non-goals (§1) exist to prevent. If
   it's wanted later, it's an additive `visibility` enum on `Comment`
   (`INTERNAL | CLIENT_VISIBLE`, default `INTERNAL`) plus new portal
   routes/queries — not a reason to delay this stage.

Every one of the checks above is enforced the same way every existing
Server Action enforces its own: resolve `{ user, organizationId }` (or
`{ ..., membership }` where role matters) via
`getCurrentUserOrganization()`/`getCurrentMembership()` server-side,
scope every query by `{ id, organizationId }` together, and compare
`comment.authorId === user.id` for the author-only actions — never a
client-supplied `organizationId`/`authorId`/role.

---

## 5. Notifications

Stated exactly, action by action, because the user's own request asked
for this precision and because vagueness here is exactly how a
notification system grows unwanted noise:

| Event | Activity? | Notification? | Email? |
|---|---|---|---|
| Comment created, **no** mentions | ✅ `COMMENT` / `CREATED` | ❌ | ❌ |
| Comment created, **with** mention(s) | ✅ `COMMENT` / `CREATED` | ✅ one `MENTIONED` Notification per mentioned, validated, non-author org member | ✅ (see below) |
| Comment edited, mention set **unchanged** | ✅ `COMMENT` / `UPDATED` | ❌ | ❌ |
| Comment edited, **new** mention(s) added | ✅ `COMMENT` / `UPDATED` | ✅ only for the **newly added** mention(s) | ✅ for those only |
| Comment edited, a mention **removed** | ✅ `COMMENT` / `UPDATED` | ❌ (no "un-notify" — the original notification already happened and stays true to what occurred) | ❌ |
| Comment soft-deleted | ✅ `COMMENT` / `DELETED` | ❌ | ❌ |

### Why every create/edit/delete gets an Activity row regardless

Consistency with literally every other entity in this app: Client,
Project, Task, Invoice, Membership, Attachment all get an Activity
entry for CREATED/UPDATED/DELETED whether or not anyone is notified
about it — Activity is the append-only "everything that happened" log,
Notification is the much narrower "someone should see this in their
inbox" layer on top of it. Comments hold themselves to the same
standard: an organization's Activity feed should be able to answer "was
a comment ever posted/edited/removed here," independent of whether it
ever produced a notification.

### Why only `@mention` notifies, never "someone commented"

Stated in §1 as a non-goal, restated here as the notification-design
reason: this app's own `NotificationType` enum comment already says the
quiet part explicitly — "deliberately not one-to-one with
ActivityAction... a new type here should mean a new fan-out rule is
actually ready to ship, not 'this action exists so it gets a
Notification counterpart too.'" A blanket "new comment on your project"
notification for every Project/Task participant would be the single
largest source of new notification volume this app has ever added,
without an explicit signal that any *particular* person needs to see it
— exactly the ambient-noise failure mode `@mention`-only avoids. If
project-owner/task-assignee ambient notifications are wanted later,
that's a new, separately-justified `NotificationType` (e.g.
`COMMENT_ON_OWNED_PROJECT`), not a default this stage should ship.

### Why edits only notify for *newly added* mentions

An edit that changes wording but not the mention set should notify no
one — otherwise fixing a typo would re-spam everyone already mentioned.
An edit that adds a mention should notify exactly that new person — they
were never told, and now they should be, exactly as if the mention had
been in the original comment. This requires the edit Server Action to
diff `old Mention set` vs. `new parsed mention set` (a `Set` difference,
computed the same way `diffProjectFields` already diffs an update
against its prior snapshot) and only pass the *added* ids as
`MENTIONED` candidates — removed mentions get their `Mention` row
deleted (the record "this comment currently mentions X" should stay
accurate) but produce no notification-retraction event, since this
system has no concept of un-notifying and inventing one is out of scope.

### Why a mention gets emailed and a bare comment never could

`MENTIONED` is added to the email allowlist
(`src/lib/notifications/email/deliver-notification-email.ts`'s
`EMAIL_ALLOWLIST`) for the same reason `ROLE_CHANGED`/
`OWNERSHIP_TRANSFERRED` are on it and `INVITATION_ACCEPTED` isn't: it's a
direct, personal, "you specifically are wanted" signal, not something
the recipient is already likely to notice on their own next login. It
goes through the exact same `shouldDeliverNotificationEmail` pipeline as
every other type — preference check first (so a user who's disabled
email for `MENTIONED` in `/settings/notifications` gets skipped, same as
any other type, no special case), then allowlist, then recipient email,
then provider configuration. **No new email-delivery code is written**
— `MENTIONED` is a new enum value plus one new allowlist entry plus one
new `NotificationRule`, exactly the extension seam §0.5 describes.

---

## 6. UI

### Placement: a new `CommentsSection`, mirroring `AttachmentsSection`

A single shared, generic component
(`src/components/comments/comments-section.tsx`, parameterized by
`entityType`/`entityId`/`organizationId`), rendered as its own section
on both the Project edit page (which already has an `AttachmentsSection`
sibling to slot next to) and the Task edit page (which today has *no*
nested section at all — Comments would be the first). Bound Server
Actions passed the same way
`ProjectAttachmentsSection`/`uploadAttachmentAction.bind(null,
projectId)` already do it — no new wiring pattern.

### Composer

A plain multi-line `<textarea>` + submit button, a bound
`createCommentAction`, `useActionState` for pending/error state —
identical shape to every other form in this app (`LoginForm`,
`NotificationPreferenceToggle`). The only client-side interactivity is
the `@`-triggered autocomplete dropdown (a small client component
island, the same scale of client-side logic `notification-preference-
toggle.tsx`'s auto-save-on-change already has) — it fetches the active
org's member list once (already-available, cheap, bounded data — the
same list the Team page itself renders) and inserts the structured token
(§3) on selection; typing `@` with no matches, or dismissing the
dropdown, just leaves plain text.

### Editing

Clicking "Edit" on your own comment (never shown for someone else's,
per §4) swaps its rendered body for the same composer textarea,
pre-filled with the current `body` (mention tokens included verbatim —
the raw stored form, not the rendered `@Jane Doe` tags), submitting to a
bound `updateCommentAction`. Cancel reverts to the rendered view with no
request made.

### Deleting

A "Delete" button/confirmation, shown for your own comment always and
for any comment when the viewer's role is OWNER/ADMIN (§4). A deleted
comment renders as a fixed, collapsed placeholder — "This comment was
deleted" — never simply removed from the list, per §2's soft-delete
reasoning; no edit/delete affordance is ever shown on an already-deleted
row.

### Empty state

"No comments yet — be the first to add one," matching this app's
existing empty-state tone (`AttachmentsSection`'s and the Notifications
inbox's own empty states use the same plain, low-key phrasing rather
than an illustration or a call-to-action banner).

### Pagination

Comments read top-to-bottom chronologically (oldest first) like a
conversation, which is the opposite display order from Activity/
Notifications' own newest-first feed — worth calling out explicitly
since it's the one place this design deliberately reverses an otherwise-
reused convention. Initial load: the most recent page (e.g. 20 comments),
fetched newest-first via the standard keyset query, then reversed for
display (oldest of that page at the top, newest at the bottom). A "Load
earlier comments" affordance above the first visible comment fetches the
next older page using the exact same `encodeActivityCursor`/
`decodeActivityCursor`-shaped helper (a new, identically-shaped
`encodeCommentCursor` — the encoding itself is generic, so this could
even be the literal same function renamed, not a reimplementation) and
prepends it. No infinite scroll, no auto-loading newer comments without
a page refresh — consistent with this app's "no polling, no realtime"
stance everywhere else.

### Future threading

Not built, but the schema (§2) is one additive, nullable
`parentCommentId String? @db.Uuid` self-relation away from supporting
it — a reply is just a `Comment` whose `parentCommentId` points at
another `Comment` in the same `entityType`/`entityId`. The UI would need
real design work (nesting depth limits, collapse/expand) this document
doesn't attempt, but nothing in §2's model blocks adding the column
later without a backfill (existing rows simply get `parentCommentId:
null`, meaning "top-level," which is already every row's real meaning
today).

---

## 7. Performance

### Indexes

`@@index([organizationId, entityType, entityId, createdAt, id])` is the
one hot-path index — every comment list fetch is `WHERE organizationId
= ? AND entityType = ? AND entityId = ? ORDER BY createdAt DESC, id DESC
LIMIT n`, identical shape to Activity's own entity-specific timeline
index. `@@index([organizationId, createdAt, id])` exists for a plausible
future "recent comments across this org" view (unused today, same
reasoning Attachment's own org-wide index gives for being added now
rather than as a later migration). `Mention`'s `@@index([mentionedUserId,
createdAt])` exists for a plausible future "comments that mention me"
view, also unused today.

### Pagination strategy

Keyset (`createdAt`, `id`) exclusively, never `OFFSET` — the same
reasoning Activity and Notifications already settled on (an `OFFSET`
against a growing table gets slower and, worse, can skip or repeat rows
under concurrent inserts; a keyset cursor can't). Bounded page size
(e.g. 20), enforced server-side regardless of what a client requests —
identical discipline to the Notifications inbox's own `LIMIT 21`
over-fetch-by-one-to-detect-more-pages trick, reusable verbatim here.

### Loading strategy

Server-rendered initial page, no client-side fetch or spinner for the
first view — identical to how the Notifications dropdown/inbox are
"server-fetched via `Promise.all` in the layout and passed as props; no
client-side fetch, no polling, no realtime." "Load earlier comments"
is the one interactive fetch, and it can be a plain Server Action
returning the next page's rows rather than a Route Handler + client
`fetch()` — keeps the same minimal-JS shape as everything else in this
app.

### Future caching

None needed at current scale, for the same reason the Notifications
doc's own "Scale expectations" section gives: this product's target
market (freelancers, small agencies) means Project/Task comment volume
per entity is realistically dozens, not thousands, and a bounded,
indexed keyset query is not a performance concern worth pre-solving.
Revisit only if real usage ever contradicts that assumption.

---

## 8. Security

### Markdown: deliberately not implemented

This is the single most consequential security decision in this
document, and it's made in the negative on purpose. Real Markdown
rendering means a parser (this codebase has none installed today — no
`marked`/`remark`/similar dependency exists in `package.json`) plus a
sanitizer to strip anything the parser would otherwise turn into raw
HTML — two new dependencies and an ongoing "did we sanitize correctly"
burden, for a feature (bold/italic/code blocks in a project comment)
this product doesn't need to ship in its first version. Comments render
as **plain text only**: React/JSX text nodes escape everything by
default, so there is no XSS surface to defend at all as long as nothing
ever routes comment content through `dangerouslySetInnerHTML` —
already a project-wide invariant this codebase actively enforces via
`scripts/security-checks/check-no-dangerous-html.mjs` (currently: zero
matches, anywhere). **Comments must not be the first feature that
becomes an exception to that check.** The only "rendering" a comment
body ever gets is the fixed mention-token regex-and-replace from §3 —
a narrow, fully-specified transform into a fixed component, not a
general-purpose parser, and therefore not a new class of injection
surface. If real Markdown is wanted later, it needs its own dedicated
design (parser choice, sanitizer choice, an update to the security-check
allowlist to scope the one legitimate `dangerouslySetInnerHTML`/
sanitized-HTML call site it would introduce) — explicitly out of scope
here.

### XSS

Follows directly from the above: since nothing about Comments ever
constructs raw HTML from user input, there is no XSS vector to close.
The mention tag itself is a fixed component
(`<MentionTag userId={...} displayName={...} />`), never string-built
HTML — the display name it renders is plain text content, escaped by
JSX exactly like any other text node.

### Permissions

Fully covered in §4 — restated here only to note the enforcement
mechanism is identical to every existing Server Action: server-side
`organizationId` resolution (never a client-supplied value),
`{ id, organizationId }` scoping on every query, `authorId`/role
comparisons for edit/delete, no exceptions.

### Rate limiting

A new `COMMENT_CREATE_LIMIT` in `src/lib/rate-limit/limits.ts`, same
shape as every existing entry (e.g. `ATTACHMENT_UPLOAD_LIMIT`: 30/hour
per authenticated staff user) — generous enough not to interfere with
normal use, tight enough to stop a single account from flooding a
Project/Task with automated or abusive comment volume. Bucketed per
user, not per entity, matching `ATTACHMENT_UPLOAD_LIMIT`'s own reasoning
("shared across Client/Project/Invoice attachments... per authenticated
staff user").

### Mention abuse

Three distinct concerns, three distinct mitigations:

1. **Cross-org probing/spam** — closed by §3's org-membership validation
   at parse time; a uuid that isn't a current member of the comment's
   own organization simply never becomes a `Mention` or a notification,
   regardless of what the raw text claims.
2. **Mass-mention flooding** — a single comment mentioning an entire
   organization's membership list at once (whether malicious or just
   careless copy-paste) shouldn't fan out unbounded email volume from
   one action. This design recommends a fixed per-comment cap (e.g. 20
   distinct mentions) enforced at the same parse step as §3's other
   validations — anything beyond the cap is simply not persisted as a
   `Mention` and doesn't notify, with no error surfaced (over-mentioning
   degrades gracefully rather than blocking the comment entirely, the
   same "ineligible input narrows silently rather than throwing"
   philosophy `shouldDeliverNotificationEmail` already uses).
3. **Notification-preference bypass** — none: `MENTIONED` goes through
   the exact same `NotificationPreference`-gated pipeline as every other
   type (§5). There is no special "mentions always notify regardless of
   settings" carve-out; a user who disables `MENTIONED` email (or
   in-app) is respected identically to disabling `ROLE_CHANGED`.

---

## 9. Testing strategy

Mirrors this codebase's existing three-layer split exactly (see
`test/unit`, `test/integration`, `test/e2e` conventions already
established by Activity/Attachments/Notifications).

### Unit (`test/unit/`)

- **Mention token parsing** — a pure function
  (`parseMentionTokens(body): {displayName, userId}[]`), tested
  exhaustively as a pure function (no DB), matching
  `notification-list-params.test.ts`'s own exhaustive-pure-function
  style: well-formed token, multiple tokens, duplicate uuids (dedup),
  malformed uuid shape, malformed bracket/paren syntax, empty body, a
  body with an `@` that isn't a token at all, mixed valid+invalid in one
  body.
- **Mention diffing on edit** — `added`/`removed` set computation given
  an old and new parsed token list.
- **Comment/Activity metadata builder** — a `buildCommentMetadata`-style
  function (matching `src/lib/activity/*-metadata.ts`'s pattern) tested
  for its allowlisted-fields-only shape (author name, an excerpt or
  entity name — never the full raw body verbatim into Activity.metadata
  if that's ever deemed too much, though the current working assumption
  is Activity.metadata can safely hold the same body Comment.body has,
  since both are equally org-internal and equally covered by §4's
  permissions).
- **Cursor encode/decode** — if a Comments-specific cursor helper is
  written rather than reusing Activity's verbatim, the same malformed-
  input test matrix `decodeActivityCursor` already has.

### Integration (`test/integration/comments/`, PGlite)

Mirroring `test/integration/notifications/dispatch.test.ts`'s own
exhaustive style for the fan-out-specific cases:

- Comment CRUD scoped correctly: cross-org id doesn't match (identical
  no-op-not-error pattern as Project/Task), cross-entity-type id
  collision doesn't leak (a Task and a Project sharing a coincidentally
  equal uuid — vanishingly unlikely with real UUIDs, but the query
  should be provably scoped by `entityType` *and* `entityId` together).
- Mention fan-out: exactly one `Notification` per validated mention,
  actor-exclusion, dedup (both parse-time and the `@@unique` constraint
  under a forced duplicate insert), a uuid for a real User in a
  *different* org produces no `Mention`/no `Notification`, a uuid for a
  nonexistent User is a silent no-op, an edit that adds one mention to a
  two-mention comment only notifies the new one.
- Soft delete: `deletedAt` set, `body` cleared, row still returned by
  the list query, `Mention` rows survive untouched, the earlier
  `Notification` row (and its `activityId`) is unaffected.
- Cascades: deleting a `Comment` cascades its `Mention` rows; deleting a
  `Project`/`Task` cascades its `Comment` rows (and, transitively, their
  `Mention` rows) — verified empirically the same way Stage 9's audit
  verified Notification's own cascade chain on a fresh PGlite instance.
- Pagination: no duplicates/gaps across pages, same-`createdAt`
  tie-break stability, invalid cursor degrades to page one rather than
  erroring — identical test shape to `test/integration/notifications/
  inbox.test.ts`.
- Permissions: MEMBER can create/edit-own/delete-own but not edit/
  delete another member's comment; OWNER/ADMIN can delete another
  member's comment; a PortalUser session has no reachable Comment query
  or action at all.

### E2E (`test/e2e/comments.spec.ts`, `test/e2e/comments-mentions.spec.ts`)

- Full composer create → appears in the list → edit → "(edited)" shown
  → delete → collapsed placeholder shown, on both a Project and a Task
  page.
- Mention autocomplete: typing `@` shows real org members, selecting one
  inserts the token, submitting produces a real notification visible in
  the mentioned user's own bell/dropdown (reusing the exact session-
  injection technique `notifications.spec.ts` already uses for its own
  "a real event produces a visible entry" tests).
- A portal-only identity has zero comment UI reachable (mirroring
  `notifications-inbox.spec.ts`'s own "a portal-only identity has no
  access to /notifications" test shape).
- Rate limit does not fire under one normal comment submission (a
  smoke check that the new limit is generous enough, not a full
  rate-limit-exhaustion test — that belongs in unit/integration against
  the rate-limit module itself, already covered by its own existing
  Stage 3 test suite).

---

## 10. Migration strategy

Purely additive, in the same spirit as every migration this codebase has
shipped for Notifications (§9 of that doc: "New models only, no changes
to existing tables"):

1. `CREATE TYPE "CommentEntityType" AS ENUM ('PROJECT', 'TASK')`.
2. `CREATE TABLE "Comment"` (all columns nullable-or-defaulted where
   shown in §2 — no backfill possible or needed, since the table starts
   empty) with its two indexes and three foreign keys (organizationId
   CASCADE, authorId SET NULL — no FK to Project/Task, per §2's
   polymorphic-target decision).
3. `CREATE TABLE "Mention"` with its unique constraint, its index, and
   two foreign keys (commentId CASCADE, mentionedUserId CASCADE).
4. `ALTER TYPE "ActivityEntityType" ADD VALUE 'COMMENT'` — reusing the
   existing generic `CREATED`/`UPDATED`/`DELETED` `ActivityAction`
   values rather than inventing Comment-specific ones, the same choice
   Client/Project/Invoice already made (Task and Membership are the
   only entities with their own extra, genuinely distinct actions like
   `STATUS_CHANGED`/`ROLE_CHANGED` — Comments have no such
   entity-specific transition to name).
5. `ALTER TYPE "NotificationType" ADD VALUE 'MENTIONED'`.
6. No change whatsoever to `NotificationPreference` — the moment
   `MENTIONED` exists as a `NotificationType` value, the entirely
   existing `NOTIFICATION_TYPES` TypeScript array (one new literal, a
   code change not a schema change) and the already-generic lazy-row/
   default-true-both/reset-deletes-rows mechanism just handle it, for
   every user, with zero new rows needed until someone actually changes
   their default.

No column is added to `Activity`, `Notification`, `NotificationDelivery`,
`Project`, `Task`, `User`, or any other existing table — Comments is
new tables plus new enum values plus new rule-table/allowlist entries in
application code, exactly the seam §0.5/§0.6 describe and exactly the
same shape every one of Notifications' own 8 real stages used to extend
this system without ever touching what already shipped.

### Suggested rollout order (mirroring the Notifications Center's own proven staging)

This document is that project's own Stage 1. If it's approved, the
natural continuation — matching what demonstrably worked for
Notifications — is:

- **Stage 2**: schema only (this doc's migration, §10 above) — no fan-
  out, no UI, `createActivity()` untouched, exactly how Notification's
  own Stage 2 shipped.
- **Stage 3**: fan-out — the `MENTIONED` `NotificationRule`, the
  mention-parsing/validation logic (§3), wired into `createActivity()`
  calls that don't exist yet because there's still no UI to trigger
  them (testable entirely via integration tests calling the create
  logic directly, the same way Notification's own fan-out stage was
  tested before any UI existed for it).
- **Stage 4**: UI — the composer, the list, edit/delete, on both Project
  and Task pages.
- **Stage 5**: email delivery — add `MENTIONED` to the allowlist, no new
  delivery code.
- **Stage 6**: preferences — likely nothing to build at all (§10 point
  6), but a real stage to *verify* that claim against a live UI instead
  of asserting it in a design doc.
- **Later, unscheduled**: attachments-on-comments, emoji reactions,
  threading, client-visible comments — each its own additive migration
  and its own design conversation, not a default extension of this one.

### Zero-regression guarantee

Every existing test suite (unit/integration/E2E, all currently green)
exercises code paths this design never touches. The only shared
infrastructure Comments extends is the notification rule table and the
email allowlist — both already designed, in Stage 6 of the Notifications
Center, to accept new entries without altering any existing one's
behavior; this document adds one row to each, changes zero.
