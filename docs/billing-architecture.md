# Billing & Subscriptions — Architecture (Stage 1)

Design-only. No production code, no migrations, no payment provider SDK, no
env vars, no PR. This document is the sole deliverable of Stage 1 — every
later stage (schema, provider integration, checkout/webhooks, enforcement/UI,
tests, legal/provider readiness, live payments) builds on the decisions
recorded here, and none of them should start without this document being
read and agreed on first.

Written after a full read of `prisma/schema.prisma`, `src/lib/current-user.ts`,
the organization switcher, `/settings/notifications` (currently the only
Settings page), the staff and Client Portal invitation flows, the Activity/
Notification fan-out system (`notification-rules.ts`, `dispatch-notifications.ts`,
`create-activity.ts`), the rate-limit catalog, both cron routes and
`vercel.json`, `README.md`, `docs/testing.md`, `docs/notifications-architecture.md`,
`docs/comments-architecture.md`, `prisma/backfill-organizations.ts`, the
attachment size/count config, and an explicit search for any existing
pricing/plan/Stripe/Paddle reference (none found — this is fully greenfield).

---

## 0. What already exists (grounding facts this whole document depends on)

- **Multi-tenancy is real, not aspirational.** `Organization`/`Membership`/`Role`
  (`OWNER`/`ADMIN`/`MEMBER`) already exist and are load-bearing:
  `getCurrentUserOrganization()`/`getCurrentMembership()` resolve the active
  org from an `httpOnly` cookie, re-verified against a real `Membership` row
  on every request (`src/lib/current-user.ts`). The org switcher
  (`getOrganizationSwitcherItems()`) already lists every org a user belongs
  to. **The billing unit for this whole design is `Organization` — never
  `User`** (§9 makes this explicit; a user can already belong to more than
  one org today).
- **Organization creation happens in exactly one place at runtime**:
  `getOrCreateOrganizationId()` in `current-user.ts`, called on a user's
  first-ever request with no existing `OWNER` Membership. It's a plain
  `prisma.$transaction` that creates `Organization` + an `OWNER` `Membership`,
  with slug collision handling and a `P2002` race-loser fallback (concurrent
  prefetches racing to auto-provision the same user's org). The only other
  `organization.create` call site is `prisma/backfill-organizations.ts`, a
  one-time, already-run, idempotent, dry-run-by-default migration script —
  not part of the live request path.
- **There is no Organization *delete* flow anywhere in application code.**
  Grepping the whole `src/` tree for `organization.delete`/`deleteMany`
  returns nothing outside the generated Prisma client's own doc comments.
  This matters directly for §16/§21: "what happens to billing state when an
  org is deleted" is currently a non-question, because orgs are never
  deleted today. Any billing feature must not be the thing that first forces
  this decision as a side effect.
- **No pricing/plan/Stripe/Paddle/subscription concept exists anywhere** —
  no schema fields, no dependency, no doc reference beyond `docs/search-
  architecture.md`'s unrelated "rollout plan" heading and `docs/notifications-
  architecture.md`'s mentions of a possible future `PushSubscription` model
  (unrelated to billing subscriptions). `package.json` has no Stripe/Paddle
  SDK installed. This is a from-scratch design.
- **One existing hard resource cap already exists as precedent**:
  `MAX_ATTACHMENTS_PER_ENTITY = 20` and `MAX_ATTACHMENT_SIZE_BYTES = 10 MB`
  (`src/lib/storage/attachments-config.ts`) — a flat, code-level, non-billing
  cap. Billing-tier limits are a *different* mechanism layered on top of
  these, not a replacement for them (§7/§8).
- **The notification/activity system is exactly the shape a billing feature
  should plug into, not reinvent.** `createActivity()` writes one `Activity`
  row inside the caller's own transaction, then `dispatchNotificationsForActivity()`
  looks up a `NotificationRule` keyed by `(ActivityEntityType, ActivityAction)`
  and fans out `Notification` rows to resolved recipients; email delivery
  is a separate, best-effort, post-commit step
  (`deliverNotificationEmails()`), gated on `RESEND_API_KEY`/
  `INVITATION_FROM_EMAIL` being configured at all (gracefully degrades to
  "created, not delivered" if not — the exact same optionality this design
  should inherit for billing emails). §17 designs new `NotificationType`
  values and rules on top of this existing machinery, not a parallel one.
- **Cron is real but constrained.** Two jobs exist today
  (`/api/cron/notification-delivery`, `/api/cron/notification-cleanup`),
  both `CRON_SECRET`-gated (`requireCronAuth`), both rate-limited as
  defense-in-depth, both scheduled **daily** in `vercel.json` because
  **this project runs on Vercel's Hobby plan, which caps Cron Jobs at once
  per day per job** (`README.md`, `docs/notifications-architecture.md`).
  Any billing reconciliation job (§18) inherits this exact same constraint.
- **`Settings` is currently a single page**, `/settings/notifications`, and
  the Sidebar's "Settings" nav item links directly to it (`src/components/
  layout/sidebar.tsx`) — there is no Settings index/section shell yet. A
  `/settings/billing` page is a new sibling route; whether "Settings" in the
  Sidebar should become a small section nav (Notifications | Billing) is a
  real UI decision for Stage 5, noted in §14 rather than resolved here.
- **Role-gating precedent already exists** in `team/actions.ts`
  (`inviteMemberAction`'s `membership.role !== OWNER && !== ADMIN` re-check,
  server-side, even though the inviting UI is only ever rendered for those
  roles) — the same "UI hint, server is the real gate" discipline this
  design's entitlement checks (§7/§8) must follow.
- **Automated security checks are a real, enforced layer**
  (`scripts/security-checks/*.mjs` + `run-all.mjs`, run via
  `npm run security:check`, part of CI). Every prior feature stage in this
  project has added at least one new check scoped to that feature (see
  `check-search-security.mjs`, `check-no-data-api-access.mjs`'s Data-API
  lockdown, `check-cron-security.mjs`). §15 assumes a `check-billing-
  security.mjs` follows the same pattern in a later stage.

---

## 1. Goals and non-goals

### What "billing v1" means for this product

This is a small B2B SaaS CRM for freelancers/small agencies. Billing v1's
entire job is: **let an Organization's `OWNER` pick a paid plan, pay for it
recurringly, and have the app correctly gate a small number of real
resource limits based on that plan — reliably, safely, and without ever
trusting the client for anything money-related.** That's the whole scope.
Everything else in this document (webhooks, entitlements, UI, security) exists
in service of that one sentence.

### Explicitly out of scope for v1 (per the task's own list, plus why)

- **Usage-based billing** (metered API calls, per-seat overage billing,
  etc.) — this product's resources (clients, projects, staff seats) are
  naturally *count* limits, not metered consumption; usage-based pricing
  needs a metering pipeline this app has no reason to build yet.
- **Marketplace / revenue sharing** — there is no multi-vendor concept in
  this product at all; nothing here is ever resold through this app.
- **Complex tax engine** — v1 relies entirely on the chosen payment
  provider's own tax handling (this is a first-class input into the §2
  provider decision, not an afterthought).
- **Enterprise invoicing** (NET-30 terms, PO numbers, manual wire transfer
  reconciliation) — v1 is self-serve, card-based subscription billing only.
- **Annual contracts with manually negotiated terms** — v1's only "annual"
  concept, if offered at all, is a standard self-serve annual price point
  on the same plan catalog (§3/§6), never a bespoke contract.

### A non-goal worth stating explicitly

Billing v1 is **not** the moment this project gains a legal business entity,
tax registration, or the ability to process *live* payments. Everything in
this document up through Stage 6 (§20) is buildable and testable entirely in
each provider's sandbox/test mode. §16/§20/§21 draw a hard line: live-mode
payment processing is Stage 8, gated on legal/provider prerequisites this
document only inventories — it does not, and cannot, satisfy them.

---

## 2. Provider decision

### Comparison, specific to this project's actual situation

The task's framing — Thailand-based individual, no legal entity yet,
plausibly-international B2B clients, need for tax/VAT handling, wanting to
*start* accepting payment — is the textbook case the "Merchant of Record"
(MoR) model exists for, and it's worth being explicit about what that model
changes structurally before comparing line items.

| | **Stripe Billing** | **Paddle Billing (Merchant of Record)** |
|---|---|---|
| Who is the legal seller of record | You are. Stripe is a payment processor; the contract with the end customer, and the tax liability for every sale, is yours. | Paddle is. They resell your product to your customer as the merchant of record — the tax liability and remittance obligation for global sales sits with them, not you. |
| Business entity requirement | Practically expects a registered business (sole proprietorship is *sometimes* workable depending on country support, but cross-border B2B SaaS with recurring billing is the case where having a real entity matters most). | Historically the more individual/indie-friendly of the two for exactly this reason — MoR status is *why* individuals without a registered company can sell internationally through it. **This must still be verified for Thailand specifically before Stage 7** (see below) — do not treat this row as settled fact. |
| VAT/sales tax across countries | Stripe Tax (paid add-on) calculates and can *collect* tax, but *you* remain responsible for registering and remitting it in every jurisdiction you owe it in. For a solo operator selling B2B internationally, this is real, ongoing compliance work. | Paddle collects, remits, and is liable for VAT/sales tax in every jurisdiction it operates in, as MoR. This is the single biggest practical reason Paddle fits this project's stated situation better than Stripe does. |
| Ability to start accepting payment without a company | Harder — most paths assume a registered legal entity behind the Stripe account. | Easier in principle (MoR absorbs much of what a company registration would otherwise be *for*, tax-wise) — **still requires verifying Paddle's own individual-seller/KYC requirements for a Thailand-based applicant before relying on this**, not something this document can certify. |
| Country support (seller side) | Stripe is available as a seller in a large number of countries; **Thailand's exact current status must be checked at stripe.com/global at implementation time** — this document does not certify it. | Paddle supports sellers in fewer countries than Stripe historically has for direct Stripe accounts; **Thailand's exact current status must be checked at paddle.com's seller eligibility page at implementation time** — same caveat, this document does not certify it either. |
| Payout requirements/currency | Payouts to a bank account tied to the Stripe account's country; for many countries this still assumes a local bank account and, often, a registered business bank account. | Payouts to the seller (you) happen on a schedule after Paddle nets out its own fee and any tax it collected/remitted on the sale — generally simpler for an individual, since Paddle isn't paying out gross-of-tax amounts a seller would then owe tax on separately. |
| Webhooks | Extremely well-documented, huge ecosystem, official Node SDK, signature verification via a standard HMAC scheme. | Also solid and officially supported (Paddle Billing's webhook model is deliberately similar in shape to Stripe's for exactly this reason — easier migration/comparison for developers evaluating both), signature verification via HMAC as well. |
| Customer portal (self-serve payment method / cancel / invoice history) | Stripe's hosted Customer Portal is mature, highly configurable, free to use. | Paddle also provides a hosted customer management/portal experience for subscriptions; generally less deeply configurable than Stripe's, but sufficient for this product's v1 scope (§11). |
| Subscriptions primitive | First-class (`Subscription`, `Price`, `Product`), very mature, most third-party tutorials/tooling target Stripe first. | First-class as of Paddle Billing (the current API generation, distinct from the older "Paddle Classic") — mature enough for a v1 SaaS subscription product, less third-party tooling/tutorial coverage than Stripe. |
| Refunds | Full API support, standard flow. | Full API support, standard flow — refund policy interacts with Paddle's own MoR tax remittance (a refunded sale unwinds the tax Paddle already collected), which is Paddle's problem to reconcile, not this app's. |
| Chargebacks/disputes | You (the merchant) handle disputes directly with the card network via Stripe's dispute flow; losing one has real cost/fee implications for your Stripe account standing. | As MoR, Paddle is the party of record on the transaction and generally absorbs more of the direct chargeback-handling burden than a pure processor would — this is one of the real practical benefits of the MoR model for an individual seller, though it does not mean chargebacks are risk-free or invisible to you (Paddle can still ultimately net the cost back if a subscription is later determined problematic). |
| Vendor lock-in | Very low — Stripe's data model and webhook shapes are the de facto industry standard; migrating *away* from Stripe if ever needed is well-trodden. | Slightly higher in the sense that "who is the seller of record" is baked into the business relationship, not just an API integration — migrating away from an MoR later (e.g. once a real Thai entity exists and direct Stripe processing becomes viable) is a bigger structural change than swapping API keys, since the legal selling relationship with existing customers changes too. |
| Cost/complexity | Lower percentage fee, but *you* absorb tax compliance cost/complexity/risk, which for solo/early-stage sellers is often underestimated. | Higher percentage fee (MoR pricing bundles in the tax handling), but meaningfully lower operational/compliance complexity and legal risk for exactly this project's current situation (no entity yet, international B2B customers, want to start now). |

### Recommendation: **Paddle Billing (Merchant of Record)**

For *this specific project, at this specific moment* (Thailand-based, no
legal entity yet, wants to start accepting international B2B payment,
explicitly needs tax/VAT handled rather than owned) — **Paddle**, not
Stripe. The deciding factor is not any individual feature row above; it's
that Paddle's entire business model (MoR) directly removes the two biggest
blockers this project currently has — *no legal entity* and *no appetite to
personally own cross-border VAT/sales-tax compliance* — while Stripe's model
leaves both of those squarely as this project's own ongoing responsibility.
Stripe remains the technically more mature, better-documented, lower-fee
option, and is the right call for a *later* stage of this business if/when
a registered legal entity exists and direct tax compliance becomes
manageable to own — but that is not where this project is today.

**This recommendation is a design-time judgment based on how each provider's
model is documented to work in general, not a substitute for verifying
Paddle's actual current eligibility rules for a Thailand-based individual
seller.** Per the task's own instruction, this is flagged explicitly as a
**pre-implementation verification item**, required before Stage 3 (test-mode
integration) starts and mandatory before Stage 7/8 (live payments):

> **Pre-implementation verification (do this before writing any provider
> integration code, and again before going live):**
> 1. Confirm Paddle's current seller eligibility/KYC requirements for an
>    individual (non-incorporated) seller based in Thailand, directly on
>    paddle.com's own current documentation — this document's comparison
>    table is necessarily a snapshot judgment, not a live source of truth.
> 2. Confirm whether Paddle requires a business entity at all for this
>    seller profile, or supports individual/sole-proprietor sellers
>    end-to-end including payout to a personal or sole-proprietor bank
>    account in Thailand.
> 3. Confirm current Paddle Billing API pricing/fee schedule (percentage +
>    any fixed fee), since fee structures change over time and this
>    document does not attempt to state a current number.
> 4. If Paddle turns out to be genuinely blocked for this seller profile,
>    Stripe becomes the fallback recommendation — but then the tax-
>    compliance-ownership question in this table becomes something this
>    project must actually solve (e.g. Stripe Tax + a real registration
>    plan), not something a provider absorbs.

---

## 3. Commercial model

### Proposed v1 plan catalog

| Plan | Price (indicative, verify before launch) | Seats (staff Memberships) | Clients | Projects | Storage | Notes |
|---|---|---|---|---|---|---|
| **Trial** | Free, time-boxed | Same as Pro, for the trial duration | Same as Pro | Same as Pro | Same as Pro | 14 days, starts at Organization creation (§9), no card required for v1 (see below) |
| **Starter** | $9/mo (or $90/yr) | 1 (just the OWNER) | 10 | 20 | 500 MB | Solo freelancer tier |
| **Pro** | $29/mo (or $290/yr) | 5 | Unlimited | Unlimited | 10 GB | Small agency tier — the plan the trial mirrors |

Two paid tiers, deliberately not three or four — the task explicitly warns
against over-fragmenting the tier list, and this product's actual
differentiator at v1 is "solo" vs. "small team," which two tiers already
express cleanly. A third ("Business"/"Agency+") tier is a natural Stage-2-
of-monetization addition once real usage data exists to justify where the
next ceiling should sit — not a v1 decision to guess at now.

**Every number above (price, seat/client/project/storage limits) is a
placeholder for this design document, not a committed number** — real
pricing is a product decision for whoever owns this project commercially,
informed by market research this document doesn't attempt. What *is*
architecturally decided here is the **shape**: two paid tiers + one trial
tier, a fixed small set of limited dimensions (seats, clients, projects,
storage), monthly and annual price points per tier.

### Definitions

- **Billing unit: `Organization`.** One `Subscription` per `Organization`
  (§5/§9) — never per `User`. A user who belongs to two orgs (already
  possible today) can be on a Trial in one and Pro in the other
  simultaneously; nothing about identity carries a plan.
- **Monthly/annual**: both offered per paid plan from v1, as two separate
  Price IDs per plan in the provider (§6) — not a discount code applied to
  a single monthly price, so each has its own stable identity for reporting
  and webhook mapping.
- **Trial duration**: 14 days, no credit card required to start (see
  rationale below).
- **Seat limits**: `maxMembers` on `Membership` count for the org (§7).
- **Client/project limits**: `maxClients`/`maxProjects`, counting live
  (non-deleted) rows. **Not** rate limits per hour like `src/lib/rate-limit`
  — a hard ceiling on total count, checked at creation time (§8).
- **Storage limits**: `maxStorageBytes`, summed from `Attachment.sizeBytes`
  for the org — a *second*, independent ceiling from the existing flat
  `MAX_ATTACHMENT_SIZE_BYTES`/`MAX_ATTACHMENTS_PER_ENTITY` caps
  (`attachments-config.ts`), which stay exactly as they are (per-file size,
  per-entity count) regardless of plan. Billing tiers add an *org-wide
  total* ceiling on top; they do not replace the existing per-file/per-
  entity ones.

### No-card trial, deliberately

The trial requires no card up front. Reasoning specific to this product:
it's a portfolio/early-stage SaaS with presumably very low signup volume
where every friction point in signup materially hurts adoption, and this
project's own auto-provisioning philosophy already optimizes hard for "zero
friction to first use" (`getOrCreateOrganizationId()` creates a workspace
silently on first login, no setup wizard). A card-required trial is a valid
alternative model (typically yields higher trial→paid conversion by
pre-qualifying more serious signups) and is explicitly *not* ruled out —
it's flagged as a real, deliberate, revisit-able choice for whoever owns
this product commercially, not something this architecture forces either
way. If switched to card-required later, the mechanics below (§9/§10) are
compatible with either — the difference is *when* Stripe/Paddle
Checkout is shown (immediately at signup vs. only when starting a paid
plan), not the state machine itself.

### Behavior at limits and transitions

| Situation | Behavior |
|---|---|
| **At/over a count limit** (e.g. 10th Client on Starter) | Creation of a new resource of that type is blocked server-side (§8) with a clear, specific error naming the limit and linking to `/settings/billing`. Existing resources are never touched. |
| **Downgrade to a lower tier while over its limits** | Never destructive. Existing data is never deleted, hidden, or made read-only just because a count now exceeds the new tier's ceiling. Only **new creation** of that resource type is blocked until the count drops back under the limit (naturally, via normal deletion) or the org upgrades again. This is the same "don't punish existing data" principle §7 states for entitlements generally. |
| **Grace period** (payment failed, but subscription not yet canceled — provider's `past_due`) | Full read/write access continues unchanged for a short grace window (7 days, see §13) — the org is not degraded the moment one payment attempt fails, since card declines are routine and often resolve on retry. |
| **`past_due` grace period expires with no successful payment** | Subscription's status (provider-driven) moves toward `unpaid`/`canceled` (§13) — access degrades to read-only at that point, not before. |
| **`canceled`** | Read access continues (existing data is never deleted or hidden — see §16/§21's own note on data retention after cancellation), but the org is treated as if it fell back to Trial-level limits for any *new* creation, and if the trial itself already expired, effectively to a minimal/blocked-creation state. Billing UI (§14) offers reactivation. |
| **Trial expired, never converted to paid** | Same as `canceled` above: read access continues, new-resource creation is blocked, upgrade path is always visible. |

---

## 4. Source of truth

- **The payment provider (Paddle, per §2) is the source of truth for
  money** — who is subscribed to what, whether a payment succeeded, current
  billing period dates, and cancellation state all originate there. This
  app never independently decides "this org paid" — it only ever *records*
  what the provider reports.
- **The local database is the source of truth for feature access** — every
  entitlement check in this app (§7/§8) reads local Prisma state
  (`Subscription.status`, `Subscription.planKey`), never calls out to the
  provider synchronously on the request path. This is a deliberate
  performance/reliability choice, not laziness: a Server Action creating a
  `Client` must never depend on Paddle's API being reachable at that
  instant.
- **Webhooks are the sync mechanism** between the two, and are themselves
  the only writer of `Subscription` rows outside of the checkout-initiation
  flow's initial "pending" record (§10/§12).

### Failure-mode behavior (webhook delay/duplicate/out-of-order, provider unavailable, stale local state)

| Scenario | Behavior |
|---|---|
| **Webhook delay** (checkout succeeded at the provider, webhook hasn't arrived yet) | The checkout success return page (§10) never flips access itself — it shows a "confirming your subscription…" state and either polls the local `Subscription` row briefly or simply tells the user access will be active within a minute, consistent with "never trust the success URL alone" (§10/§15). The org's entitlements stay at their pre-checkout level (most commonly still Trial) until the webhook actually lands and updates the row. |
| **Duplicate webhook** (provider redelivers the same event, common and expected) | Every webhook handler is idempotent by construction: each inbound event's provider-assigned event ID is checked against a `WebhookEvent` table (§5) before any `Subscription` mutation; an already-processed event ID short-circuits to a 200 with no further writes. This is the same "one row, checked before mutating" discipline `NotificationDelivery`'s own `@@unique([notificationId, channel])` already models in this codebase. |
| **Out-of-order webhook** (e.g. a `subscription.updated` for period N arrives after one for period N+1) | Every `Subscription` update is guarded by comparing the incoming event's own timestamp/version against the row's last-applied event timestamp (stored alongside the row, §5) — an event older than what's already applied is a no-op, not a regression. This mirrors how `Comment.editedAt`-style "last write wins by timestamp, not by arrival order" reasoning already exists conceptually in this codebase's Activity/Comment append-only design, generalized to webhooks. |
| **Provider unavailable** (Paddle's API/webhook delivery is down) | The app keeps functioning against whatever the local `Subscription` row last said — degraded to "possibly stale plan info" for the outage window, never to "no access at all." Paddle (like Stripe) retries webhook delivery with backoff for a substantial window (typically days), so a transient outage self-heals once the provider recovers, reinforced by the daily reconciliation job (§18) as a backstop. |
| **Stale local state** (webhook was missed entirely — provider retried past its own window, or a bug dropped it) | This is exactly what the daily reconciliation cron (§18) exists to catch: for every org with an active-ish local subscription, re-fetch the true state from the provider's API and correct any drift. This is a *read-and-repair* job, never a job that takes destructive action (e.g. auto-cancel) purely from a local absence of recent webhook activity — see §18's explicit "no destructive automation without provider confirmation" rule. |

---

## 5. Prisma model design (described, not implemented)

No models are added in this stage. This section is the *design* the Stage 2
migration will implement.

### Entities

**`BillingCustomer`** — one row per `Organization` that has ever started a
checkout, mapping this app's org to the provider's own customer object.

- `id` (uuid, pk)
- `organizationId` (unique — one `BillingCustomer` per org, `onDelete:
  Cascade` from `Organization`, matching every other org-scoped model in
  this schema, e.g. `Attachment`, `Comment`)
- `provider` (`"paddle"` for v1 — an enum of one value today, not a free
  string, so a second provider later is an additive enum value, not a
  schema-shape change)
- `providerCustomerId` (string, unique — Paddle's customer id)
- `createdAt`/`updatedAt`

**`Subscription`** — a **separate table, not fields bolted onto
`Organization`.** Reasoning: `Organization` is read on nearly every request
in this app (`resolveActiveOrganizationId()` alone touches it constantly);
subscription state changes independently and far less often, and mixing a
frequently-read, rarely-written row with a rarely-read-outside-billing-
checks, occasionally-written one just adds unrelated columns to the
already-central `Organization` model. A separate table also cleanly
supports "one row, always the current state" as an invariant the schema
itself expresses (`@@unique([organizationId])` — one active Subscription
row per org, not a history table; history lives in `WebhookEvent`, below).

- `id` (uuid, pk)
- `organizationId` (unique, `onDelete: Cascade` from `Organization` — if an
  org is ever actually deleted in a future stage, its subscription record
  has no reason to survive independently; the provider-side subscription
  itself would need its own explicit cancellation as part of that same org-
  deletion flow, whenever it's built — not something this stage designs)
- `billingCustomerId` (fk → `BillingCustomer`, required once a checkout has
  ever started; a brand-new org with no `Subscription` row at all simply
  means "on Trial, never started checkout" — see §6 on Trial not needing a
  row at all, or needing a minimal one; resolved in Stage 2)
- `providerSubscriptionId` (string, unique, nullable until checkout
  completes)
- `planKey` (string — a **stable, code-defined key** like `"starter"`/
  `"pro"`, not the provider's raw price ID; see §6 for why)
- `interval` (`"monthly" | "annual"`)
- `status` — an enum mirroring the provider's own subscription status
  vocabulary, not reinventing one: `trialing`, `active`, `past_due`,
  `unpaid`, `canceled`, `incomplete`, and `paused` only if the chosen
  provider actually supports it (§13 works through each in detail — this
  is the schema enum backing that table)
- `currentPeriodStart` / `currentPeriodEnd` (DateTime — mirrors the
  provider's billing period, used for trial/grace countdowns in the UI)
- `cancelAtPeriodEnd` (boolean — true when the user has canceled but the
  period they already paid for hasn't ended yet; `status` stays `active`
  until the period actually ends, matching how both Stripe and Paddle model
  this)
- `trialEnd` (DateTime, nullable — set once at trial start, §9; distinct
  from `currentPeriodEnd` because a converted-to-paid subscription still
  wants its original trial-end date on record for reporting, even after
  it's no longer the relevant "when does access change" date)
- `gracePeriodEnd` (DateTime, nullable — computed and stored, not
  recomputed ad hoc, when `status` enters `past_due`; §3/§13's 7-day
  window)
- `lastAppliedEventAt` (DateTime — the out-of-order-webhook guard from §4;
  every mutating webhook handler checks this before writing)
- `createdAt` / `updatedAt`

**`WebhookEvent`** — the idempotency ledger, one row per **provider event
ID**, append-only (same discipline as `Activity`).

- `id` (uuid, pk — this app's own row id, not the provider's event id)
- `provider` (same enum as `BillingCustomer.provider`)
- `providerEventId` (string, **unique** — this is the actual idempotency
  key; a duplicate delivery's insert attempt hits this constraint and the
  handler treats that as "already processed," the same pattern
  `NotificationDelivery`'s `@@unique([notificationId, channel])` already
  uses in this codebase for an analogous "don't do this twice" guarantee)
- `eventType` (string — the provider's own event name, e.g.
  `subscription.updated`)
- `organizationId` (nullable fk, `onDelete: SetNull` — same reasoning as
  `Activity.actorId`: this row is a historical/audit record that must
  survive independently of the org it was about, should an org ever be
  deletable in the future)
- `processedAt` (DateTime, nullable — null briefly between "received" and
  "handler finished"; a webhook retried mid-processing due to a crash finds
  this still null and safely reprocesses, the same "claim, don't half-
  apply" discipline `NotificationDelivery.lockedAt` already uses for its
  own retry-safety)
- `payloadSummary` (Json, small, **allowlisted fields only** — see "what
  not to store" below, never the full raw payload)
- `createdAt`

**Plan catalog: code, not a table.** See §6 for the full reasoning — no
`Plan` model is added. `planKey` on `Subscription` is a plain string
validated against a compile-time TypeScript catalog.

**`UsageCounter`: optional, and not needed for v1.** The proposed limits
(§3/§7) — members, clients, projects, storage — are all things this schema
can already count live with a `COUNT(*)`/`SUM(sizeBytes)` query at
enforcement time (`Membership`, `Client`, `Project`, `Attachment` all
already exist and are already org-scoped). A denormalized `UsageCounter`
table would only be justified if those live counts become a real
performance problem at some future scale — premature to add now, and adding
it later is a pure-addition migration with no schema conflict, so nothing
is lost by deferring it.

### Decisions, explicit

- **Separate `Subscription` table**, not fields on `Organization` — see
  above.
- **Provider IDs are opaque strings**, never assumed to have a particular
  shape (no regex validation baked into the schema) — providers change ID
  formats between API versions.
- **`status` is a real Prisma enum**, not a string — for exhaustive
  TypeScript switch-checking in every place §13's table needs to be
  enforced in code (a new provider status value added later is then a
  compile error everywhere it isn't handled, not a silent fallthrough).
- **`cancelAtPeriodEnd`/`trialEnd`/`gracePeriodEnd` as explicit columns**,
  not derived — because they're each independently meaningful for UI/cron
  (§14/§18) and deriving them from provider timestamps on every read would
  mean re-fetching the provider on every page load, which §4 already rules
  out.
- **Webhook idempotency via a real unique constraint** on
  `providerEventId`, not an application-level "have I seen this before"
  cache — a cache can be wrong after a restart; a database constraint
  cannot.
- **Timestamps**: every model gets `createdAt`; mutable ones get
  `updatedAt` — matching this schema's existing universal convention (every
  single model already does this).
- **Indexes**: `@@index([organizationId])` wherever a lookup by org is the
  primary access pattern (every enforcement check in §8 starts from an
  `organizationId`) — the same indexing discipline `Client`/`Project`/
  `Task`/`Invoice`/`Attachment`/`Comment` already apply for their own
  `organizationId` columns.
- **FK delete behavior**: `Cascade` from `Organization` for
  `BillingCustomer`/`Subscription` (they have no independent meaning
  without their org — same reasoning as `Membership`'s existing `Cascade`),
  `SetNull` for `WebhookEvent.organizationId` (audit trail survives
  independently — same reasoning as `Activity.actorId`).

### What this schema must never store

- **Card data, bank data** — never touches this app's database at all; both
  Stripe and Paddle's hosted Checkout/Customer Portal mean this app never
  receives raw payment instrument data in the first place (not "we store it
  encrypted" — we never receive it, full stop, same as this app never
  touches Supabase Auth's own password hashing today).
- **Raw webhook payload, without necessity** — `WebhookEvent.payloadSummary`
  is an explicitly allowlisted small `Json` snapshot (subscription id,
  status, period dates, plan key) for debugging/audit, mirroring
  `Activity.metadata`'s own "snapshot + diff, never full payloads" rule
  stated directly in that model's doc comment today. The full raw payload
  is never persisted.
- **Secrets** — the webhook signing secret and API key live in env vars
  only (§15), never in any table, never in `payloadSummary`.
- **Tax documents** — entirely the provider's domain under the MoR model
  (§2); this app never generates, stores, or transmits tax forms/invoices
  as PDFs or documents. If the provider's own hosted invoice/receipt pages
  are linked to (§11), that's a link to the provider's own hosted page,
  never a locally-stored copy.

---

## 6. Plan catalog

**Plans live in code, not the database, for v1** — a small, typed,
compile-time catalog:

```ts
// illustrative shape only — not implementation
type PlanKey = "trial" | "starter" | "pro";

type Plan = {
  key: PlanKey;
  displayName: string;
  limits: {
    maxMembers: number;
    maxClients: number | null; // null = unlimited
    maxProjects: number | null;
    maxStorageBytes: number;
  };
  priceIds: {
    monthly: string; // provider price/product id, from env
    annual: string;
  } | null; // null for "trial" — it has no price at all
};
```

`Subscription.planKey` stores `"starter"`/`"pro"` (never `"trial"` as a
`Subscription` row at all — see §9 on trial representation); the catalog
above is the single place limits and provider price IDs are defined, and
every entitlement lookup (§7) and checkout call (§10) reads from it, never
recomputing plan shape ad hoc.

### Why code, not a `Plan` table

- **Type safety**: `PlanKey` as a TypeScript union means every place that
  branches on plan (`switch (plan.key)`) is exhaustively checked by the
  compiler — a `Plan` row in the database gives no such guarantee, and this
  codebase already leans hard on this kind of compile-time exhaustiveness
  (e.g. `ActivityAction`/`NotificationType` as Prisma enums specifically so
  TypeScript catches an unhandled case).
- **Deploy-time review**: a price change is a code review + deploy, the
  same trust boundary every other business rule in this app already goes
  through (rate limits, attachment size caps) — not a silent database edit
  an admin panel could make with no code review at all.
- **No admin UI needed**: a `Plan` table implies *something* writes to it —
  either a migration (no better than code) or an admin UI this project has
  no other need for and would have to build, test, and secure for no real
  benefit at v1's scale (two paid plans).

### Preventing catalog/provider drift

- **Provider price IDs are the only provider-specific data in the
  catalog**, sourced from env vars (`PADDLE_PRICE_STARTER_MONTHLY`, etc. —
  naming illustrative, decided in Stage 2/3), never hardcoded — so
  test-mode vs. live-mode price IDs differ per environment without a code
  change (§19's "migration from test to live price IDs" risk in §21 is
  exactly this: swapping env var values, never editing `PlanKey`/limits
  themselves).
- **A dedicated integration test** (§19) fetches the provider's actual
  price/product objects for every `priceIds` entry in the catalog and
  asserts they exist and are active — catching "someone archived a price in
  the Paddle dashboard and forgot to update the env var" before it reaches
  users, not after a failed checkout report.
- **A startup/build-time assertion** (not a network call — just internal
  consistency) that every `PlanKey` other than `"trial"` has both a
  `monthly` and `annual` price ID configured, so a half-configured plan
  fails loudly at build/boot rather than silently offering a broken
  checkout button.

### Changing price later

Add a new price ID in the provider dashboard (test mode first), point the
relevant env var at it, deploy. Existing subscribers keep their
already-subscribed price — this app never force-migrates a subscriber to a
new price ID without an explicit, deliberate migration action (out of scope
for v1; both Stripe and Paddle support "grandfather existing subscribers"
naturally by simply not touching their `Subscription`).

### Supporting annual later, cleanly

Already supported by the shape above (`priceIds.monthly`/`priceIds.annual`
both exist from day one) — "later" here really means "flip on in the
checkout UI (§10) once both price IDs are actually configured," not a
schema or catalog-shape change.

---

## 7. Entitlements

### Single backend API

```ts
// illustrative shape only — not implementation
type Entitlements = {
  planKey: PlanKey;
  status: SubscriptionStatus; // trialing | active | past_due | unpaid | canceled | ...
  canCreateNewResources: boolean; // derived from status, see §13
  canInviteMembers: boolean;
  maxMembers: number;
  currentMembers: number;
  maxClients: number | null;
  currentClients: number;
  maxProjects: number | null;
  currentProjects: number;
  maxStorageBytes: number;
  currentStorageBytes: number;
  commentsEnabled: boolean;
  portalEnabled: boolean;
};

async function getOrganizationEntitlements(organizationId: string): Promise<Entitlements>;
```

One function, one call site pattern, mirroring how `getCurrentUserOrganization()`
is already the single resolved-context function every page/action in this
app calls rather than each reimplementing cookie/Membership lookups.
`getOrganizationEntitlements()` reads the local `Subscription` row (§4) plus
live counts (`Membership`/`Client`/`Project`/`Attachment` counts scoped by
`organizationId` — the same `@@index([organizationId])`-backed queries this
schema already supports), never calls the provider synchronously.

### What v1 actually limits — and what it deliberately doesn't

**Real limits in v1**: `maxMembers`, `maxClients`, `maxProjects`,
`maxStorageBytes` — every one of these is a genuine, meaningful resource
this app already tracks and that scales with real usage/cost (more staff
seats, more data, more storage). These are the dimensions worth
differentiating Starter from Pro on.

**`commentsEnabled`/`portalEnabled` are listed in the example because the
task asked for them, but this document does not recommend actually gating
either one in v1**, and explains why: Comments (`docs/comments-architecture.md`)
and the Client Portal are both core product features already fully built
and already part of what makes this CRM useful at all — turning them off
for a lower tier isn't a genuine resource-cost differentiator the way seat
count or storage is, it's an artificial "pay more to get the product to
actually work" wall that would make Starter feel deliberately crippled
rather than "smaller." The task itself says not to restrict features "just
for artificial differentiation" — this is exactly that trap, and this
document's actual recommendation is to leave both `commentsEnabled` and
`portalEnabled` as `true` for every plan in v1, kept in the `Entitlements`
shape only so a *future*, deliberate product decision to gate one of them
doesn't need a new field added later.

### Enforcement model

- **Server-side enforcement is the only real gate** — every enforcement
  point in §8 calls `getOrganizationEntitlements()` inside the same Server
  Action that would create the resource, before the write, exactly the
  same "server re-verifies, UI is just a convenience" discipline
  `inviteMemberAction`'s existing role re-check already models.
- **UI hints** (disabled "New Client" button with a tooltip, a usage bar in
  Settings — §14) exist purely to avoid the bad experience of "click
  Create, get a server error" — they are never the actual security/business
  boundary, and the server-side check must produce a correct result even if
  every UI hint were deleted.
- **Race/concurrency**: two near-simultaneous "create Client" requests for
  an org sitting at exactly the limit could both pass a naive pre-check
  read. v1's answer: the count check and the insert happen inside the same
  Prisma transaction, re-reading the count with the transaction's own
  consistent snapshot immediately before the insert — the same pattern
  `getOrCreateOrganizationId()` already uses (read-inside-transaction,
  re-check after) to handle its own race (concurrent first-login
  prefetches). This makes "exactly at the limit, two requests, one should
  win" correct without needing a database-level check constraint (which
  can't easily express "count of a *different* table stays under N").
- **Existing data after downgrade**: never touched, never hidden — §3's
  table already states this; `getOrganizationEntitlements()`'s
  `current*` counts can legitimately exceed `max*` after a downgrade, and
  that's an expected, valid state, not an error state.
- **Read-only mode vs. blocking new creation**: v1 only ever blocks *new
  creation* of the limited resource types. It never makes existing data
  read-only as a limits-enforcement mechanism — "read-only mode" in this
  document only ever refers to the `past_due`/`unpaid`/`canceled` *payment*
  states in §13, which is a completely different axis (payment health) from
  resource-count limits (plan tier). Conflating the two would mean a
  perfectly-paid-up org that happens to be over a soft limit suddenly can't
  edit an existing Task's status, which is not what any real product does
  and not what this design does either.

---

## 8. Enforcement points

For every call site: which entitlement, where exactly, what error, whether
it's atomic with the write, and what's explicitly *not* blocked.

| Action | Entitlement checked | Where | Error shown | Atomicity | Never blocked |
|---|---|---|---|---|---|
| **Create Organization** | None — org creation itself is never gated; every new org starts on Trial (§9) automatically, no plan choice required to sign up at all. | `getOrCreateOrganizationId()` (unchanged) | n/a | n/a | Signup itself, always |
| **Invite staff member** (`inviteMemberAction`) | `canInviteMembers` / `maxMembers` vs. current `Membership` count (pending `PENDING` `Invitation` rows count too — inviting 5 people for a 5-seat plan should be blocked at the invite, not silently allowed to over-accept later) | Top of `inviteMemberAction`, alongside its existing role re-check, before the `Invitation` upsert | "Your plan allows up to N team members. Upgrade to invite more." | Same transaction as the `Invitation` create | Resending an existing invitation; canceling one; accepting one already sent before a downgrade (already-pending invitations are honored even if the org is now over-limit — never silently revoked by a plan change) |
| **Invite Client Portal user** | Not limited by seats (`PortalUser` is a separate identity space, §0) — v1 does **not** cap portal users at all, since they're the org's own clients, not staff cost; capping them would be charging the OWNER for their *customers* existing, which doesn't match how this product's value is priced | n/a for v1 | n/a | n/a | Everything — deliberately unlimited in v1 |
| **Create Client** | `maxClients` vs. current `Client` count for the org | Top of the Client `new/actions.ts` Server Action, before `client.create` | "Your plan allows up to N clients. Upgrade to add more." | Same transaction as the `Client` create (count re-read inside the transaction, §7's race handling) | Editing/deleting an existing Client; creating a Project/Task/Invoice under an existing Client |
| **Create Project** | `maxProjects` vs. current `Project` count for the org | Top of the Project `new/actions.ts` Server Action | "Your plan allows up to N projects. Upgrade to add more." | Same transaction as the `Project` create | Editing/deleting an existing Project; Tasks/Invoices under an existing Project |
| **Upload Attachment** | `maxStorageBytes` vs. `SUM(Attachment.sizeBytes)` for the org, **checked in addition to** the existing flat `MAX_ATTACHMENT_SIZE_BYTES`/`MAX_ATTACHMENTS_PER_ENTITY` checks (both must pass — plan storage ceiling is a new, independent check, not a replacement) | `uploadAttachmentForEntity()`, alongside its existing size/count validation | "Uploading this file would exceed your plan's N GB storage limit. Upgrade for more storage, or remove an existing file." | The size-sum check and the `attachment.create` happen in the same transaction as the existing upload flow | Downloading/viewing existing attachments; deleting one (which *frees* quota) |
| **Post a Comment** | Not limited in v1 — §7 already explains why `commentsEnabled` is left `true` for every plan; a Comment has no meaningful per-org storage/seat cost distinct from what `COMMENT_CREATE_LIMIT` (existing hourly rate limit) already bounds | n/a for v1 | n/a | n/a | Everything |

**What's never blocked, project-wide**: reading/viewing existing data;
editing or deleting existing resources (a downgrade never turns existing
data into a trap the user can't clean up); the Client Portal experience
itself (portal UI is explicitly out of scope for this stage's changes per
the task, and isn't gated by staff-side billing in v1 regardless); signing
out; switching organizations; the notification/activity feeds.

---

## 9. Signup / trial flow

- **New staff signup**: unchanged entry point (`/signup` → Supabase
  `auth.signUp`). The very next dashboard visit still auto-provisions an
  `Organization` + `OWNER` `Membership` via the existing
  `getOrCreateOrganizationId()` — **billing v1 adds nothing to this call**,
  on purpose. Trial state is *implicit*: an org with no `Subscription` row
  at all, and whose `Organization.createdAt` is within the last 14 days, **is**
  the trial (§6 already noted no `Subscription` row is created for
  `"trial"`). This avoids writing a `Subscription` row at signup time for
  every single new org (most of which may never convert), keeping the hot
  auto-provisioning path exactly as fast and simple as it is today.
- **Trial end**: computed, not stored redundantly — `trialEnd = Organization.createdAt
  + 14 days` for any org with no `Subscription` row. Once an org starts a
  real subscription (even mid-trial, via early upgrade), a `Subscription`
  row is created and *that* row's own `trialEnd`/`status` (`trialing` if
  the provider's own subscription itself starts with a trial period,
  `active` if not) becomes authoritative instead. This means "trial" always
  has exactly one source of truth at any given moment — never two
  competing clocks.
- **No-card trial vs. card-required trial**: §3 already recommends no-card
  for v1 and explains the reasoning; this flow section just notes the
  mechanical consequence — no-card means no `BillingCustomer`/`Subscription`
  row is created at signup at all (nothing to create, since no checkout
  ever ran). A future switch to card-required would mean Checkout (§10)
  runs *during* signup instead of only when explicitly upgrading, with the
  resulting `Subscription.status` starting as `trialing`.
- **Trial expiring, never converted**: `getOrganizationEntitlements()`
  computes `canCreateNewResources: false` for an org whose trial window has
  passed and has no active `Subscription` — same "block new creation only"
  behavior as any other non-paying state (§8's per-resource checks all key
  off this one boolean, not off "trial" specifically, so a canceled paid
  subscriber and an expired trial hit the exact same enforcement code
  path).
- **Returning user**: logging back in re-resolves the exact same
  `Subscription` row (or its absence) via `organizationId` — nothing about
  auth session lifecycle interacts with billing state at all; a user
  logging in and out repeatedly never re-triggers or resets a trial clock,
  since the clock is anchored to `Organization.createdAt`/`Subscription`
  rows, never to a session.
- **Invited user**: joins an *existing* org via `acceptInvitationAction`
  (unchanged) — they inherit whatever plan/trial state that org already has.
  An invited `MEMBER`/`ADMIN` never sees billing UI at all in v1 (§11 — OWNER-
  only), so there is no invited-user-specific billing flow to design beyond
  "the org they joined already has whatever plan it has."
- **Dual-organization user, org switching with different subscriptions**:
  because entitlements are resolved per-`organizationId`, never per-user or
  cached in the session, switching the active org (`setActiveOrganization()`,
  unchanged) automatically resolves a *different* `Entitlements` result on
  the very next request — there is no separate "refresh billing state"
  step needed, the same way switching orgs today already transparently
  changes which Clients/Projects/Tasks are visible with zero extra billing-
  specific plumbing. This is the direct payoff of §0/§9's repeated point:
  **subscriptions belong to `Organization`, never to `User`.**

---

## 10. Checkout flow

1. **Settings → Billing** (`/settings/billing`, §14) — `OWNER` only (§11).
   Shows current plan/status and an "Upgrade"/"Choose a plan" CTA.
2. **Choose plan** — user picks a `PlanKey` + interval (monthly/annual) from
   the catalog (§6); this selection is a UI-only convenience, never trusted
   as-is by the server (§15 — the server independently validates the
   selected `PlanKey`/interval maps to an allowlisted price ID before doing
   anything with it).
3. **Create checkout session** — a Server Action, `OWNER`-gated (re-checked
   server-side via `getCurrentMembership()`, exactly like every other
   privileged action in this app), calls the provider's Checkout Session
   creation API with: the resolved price ID (server-side lookup from the
   catalog by `PlanKey`, never a client-supplied price ID — §15), the
   org's `BillingCustomer.providerCustomerId` if one already exists (reuse,
   see below) or lets the provider create one, and success/cancel return
   URLs scoped to this app's own domain only (§15's open-redirect
   protection).
4. **Redirect** — the user is sent to the provider's hosted Checkout page
   (Paddle-hosted, per §2) — this app never renders a card-entry form
   itself.
5. **Success/cancel return** — the provider redirects back to this app's
   own `/settings/billing?checkout=success` (or `=canceled`) URL.
   **Critically: this return alone never flips any entitlement.** The
   success page shows a "confirming…" state (§4's webhook-delay handling)
   and the *real* activation happens only when the webhook lands (next
   step) — this is the single most important security property of the
   whole checkout flow (§15 restates it as its own bullet, because it's the
   most common real-world billing bug: trusting a client-controlled
   redirect as proof of payment).
6. **Webhook confirmation** — `subscription.created`/`subscription.activated`
   (exact event name per §12, provider-dependent) arrives, is verified
   (signature, §12/§15), matched to the org via the checkout session's own
   metadata (the `organizationId` was attached to the Checkout Session at
   creation time in step 3 — never re-derived from anything client-
   supplied), and only *this* write creates/updates the `Subscription` row
   that `getOrganizationEntitlements()` actually reads.
7. **Idempotency**: creating a checkout session is itself rate-limited
   (new `CHECKOUT_SESSION_LIMIT`, same shape as every existing rate limit
   in `src/lib/rate-limit/limits.ts`) and the Server Action checks for an
   existing non-terminal `Subscription` for the org first — **one active
   subscription per org** is enforced at this step: if the org already has
   an `active`/`trialing`/`past_due` subscription, the "create checkout"
   action instead redirects to the Customer Portal (§11, for a plan
   *change*) rather than starting a second, competing checkout.
8. **Existing customer reuse**: `BillingCustomer.providerCustomerId` is
   looked up by `organizationId` before creating a checkout session — an
   org that churned and comes back to resubscribe reuses the same provider
   customer object rather than creating a duplicate, keeping that org's
   full payment history attached to one customer record on the provider
   side.

---

## 11. Customer portal

The provider's own hosted Customer Portal (Paddle's subscription management
page, per §2) is embedded/linked to, never rebuilt — same "let the provider
own anything payment-instrument-adjacent" principle as Checkout itself.
Exposes:

- Manage payment method
- Cancel (sets `cancelAtPeriodEnd`, not an immediate hard cancel — §13)
- Resume (undo a pending cancellation, while still within the current
  period)
- Invoice/receipt history (the provider's own hosted records — §5's "never
  store tax documents locally" holds here too)
- Plan change (upgrade/downgrade between Starter/Pro, and monthly/annual)

### Access: OWNER only

**Decision: `OWNER` only for v1**, not `ADMIN` read-only. Reasoning: this
product's existing `Role` model already treats `OWNER` as the one role with
irreversible/high-stakes powers (`OWNERSHIP_TRANSFERRED`, and
`inviteMemberAction`'s own role-assignment rules restrict who can grant
`OWNER`) — payment method and cancellation are squarely in that same
category, and a small-team product (2-5 seats at the Pro tier) doesn't have
a strong case for a second "can see the invoice history but not touch
anything" role in v1. This is explicitly flagged as **revisitable**: if a
real customer asks for `ADMIN` read-only visibility into billing (e.g. an
agency's ops person who isn't the account OWNER), that's a small,
additive, backward-compatible change to the same `getCurrentMembership()`-
based gate already used everywhere else in this app — not a redesign.

---

## 12. Webhooks

### Events needed for v1 (Paddle Billing naming; Stripe's equivalents noted for reference since the recommendation could theoretically change per §2's own hedge)

| Event | Local change | Notes |
|---|---|---|
| `subscription.created` | Create/upsert `Subscription` row, `status` per provider payload (`trialing` or `active`), set `BillingCustomer` if not already present | The step 6 event in §10's checkout flow |
| `subscription.updated` | Update `status`, `currentPeriodStart/End`, `cancelAtPeriodEnd`, `planKey`/`interval` (covers plan changes via the Customer Portal, §11) | Out-of-order guard (§4/§5's `lastAppliedEventAt`) matters most here — this is the highest-volume event type |
| `subscription.canceled` | Set `status = canceled`, keep the row (never delete it — historical record) | Fired when a subscription actually ends, not when cancellation is merely scheduled (that's `cancelAtPeriodEnd` via `subscription.updated`) |
| `subscription.past_due` *(or the provider's equivalent status transition within `subscription.updated`)* | Set `status = past_due`, compute and store `gracePeriodEnd` (§3/§5) | Triggers the past-due banner/email (§14/§17) |
| `subscription.paused` *(only if the provider supports it — §13 handles this conditionally)* | Set `status = paused` | Not all providers have this state; the design tolerates its absence |
| `transaction.completed` / `invoice.paid` *(provider-naming-dependent)* | No `Subscription` status change by itself (that's `subscription.updated`'s job) — used only to trigger the "payment succeeded" notification (§17) and, optionally, to resolve a `past_due` grace period early if payment succeeds before it lapses | Payment success and subscription-status-become-active aren't always the exact same event depending on provider — handled as two logically distinct triggers even if often correlated in practice |
| `transaction.payment_failed` *(provider-naming-dependent)* | No direct `Subscription` write (the provider's own subsequent `subscription.updated`/`past_due` event is what actually changes status) — used only to trigger the "payment failed" notification (§17) promptly, rather than waiting for the slower status-transition event | Separating "tell the user fast" from "change enforcement state" avoids a notification being blocked on exactly the same write that might be delayed/retried |

### For every event, uniformly (the handler's own shared shape, not repeated per-event logic)

- **Idempotency**: insert into `WebhookEvent` keyed on `providerEventId`
  first, inside the same transaction as any `Subscription` mutation — a
  duplicate delivery's insert fails the unique constraint, caught, treated
  as "already handled," 200 returned immediately with no further writes
  (§4/§5).
- **Ordering**: `lastAppliedEventAt` compare-and-skip, per §4/§5 — never
  assume delivery order matches event order.
- **Retry**: the provider retries failed/non-2xx deliveries on its own
  schedule — this app's only job is to return a fast, correct 2xx once
  processed (or a 4xx/5xx if genuinely unable to process, which triggers
  the provider's own retry) and never do slow synchronous work (e.g. email
  sending) *inside* the webhook request itself — mirrors
  `deliverNotificationEmails()`'s existing "post-commit, best-effort,
  outside the transaction" pattern exactly.
- **Signature verification**: every request to the webhook route is
  verified against the provider's HMAC signature using the webhook signing
  secret (env var, server-only, §15) **before** touching the request body
  for anything else — an unverified request is rejected outright, the same
  "auth check before any other logic runs" discipline `requireCronAuth()`
  already models for cron routes in this app.
- **Generic response**: the webhook route's response body is minimal/generic
  (e.g. `{ received: true }`) regardless of what internally happened —
  never echoes back subscription details, error internals, or anything
  that could help an attacker probe the endpoint's behavior, mirroring how
  `/api/search`'s own 500 handler already returns a fixed generic message
  never the real error (§15 restates this).
- **Logging without PII**: logs (if any) record `provider`, `eventType`,
  `providerEventId`, and outcome (`processed`/`skipped-duplicate`/`error`)
  — never the customer's email, payment details, or full payload, matching
  this app's existing "never log tokens/PII" discipline already stated
  verbatim in `Attachment`'s and `Comment`'s own schema doc comments and
  enforced today by `check-no-public-secrets.mjs`-style automated checks.
- **Event retention**: `WebhookEvent` rows are kept, not pruned aggressively
  — unlike `Notification`'s own 90-day read-cleanup cron (§18 references
  this precedent), billing events are a financial audit trail and default
  to indefinite retention in v1; a retention/archival policy is a Stage 7+
  (legal/compliance-informed) decision, not a Stage 2 schema default.
- **No session dependency**: the webhook route is a plain Route Handler
  with **zero** cookie/session/Membership reads — the exact same isolation
  `/api/cron/*` already has from user sessions (`requireCronAuth` never
  touches a session either), because a webhook is a server-to-server call
  with no browser session behind it at all.

---

## 13. Billing states

| Status | App access | Create new data | Read access | Grace period | Banner | CTA |
|---|---|---|---|---|---|---|
| **trialing** | Full | Yes, within trial-tier limits (mirrors Pro, §3) | Full | n/a (trial itself is the "grace") | "X days left in your trial" once ≤5 days remain | "Choose a plan" |
| **active** | Full | Yes, within plan limits | Full | n/a | None (unless near a soft usage limit — a *usage* bar, not a status banner, §14) | "Manage billing" (low-key) |
| **past_due** | Full | Yes — this is the point of the grace period (§3) | Full | 7 days from the triggering payment failure (`gracePeriodEnd`, §5) | Persistent, non-dismissible-until-resolved: "Your payment failed — update your payment method within N days to avoid losing access" | "Update payment method" → Customer Portal (§11) |
| **unpaid** *(grace period lapsed with no successful payment)* | Read-only | **No** | Full (existing data, never hidden — §16/§21) | Ended | Persistent: "Your subscription is unpaid — new data can't be created until this is resolved" | "Update payment method" |
| **canceled** | Read-only | No (falls back to §9's "expired trial" enforcement path) | Full | n/a | Persistent but lower-urgency: "Your subscription has ended" | "Reactivate" → Checkout (§10) |
| **incomplete** *(checkout started, first payment not yet confirmed — e.g. requires 3DS/bank confirmation)* | Same as whatever the org's prior state was (most commonly: still Trial) | Per that prior state | Full | n/a | "Finishing setting up your subscription…" (informational, not urgent) | "Complete payment" (deep-link back to the provider's own confirmation step, if applicable) |
| **paused** *(only if the chosen provider supports it — flagged conditional per §12)* | Read-only | No | Full | n/a | "Your subscription is paused" | "Resume" |

Every "No" in the "Create new data" column is enforced by exactly the same
`getOrganizationEntitlements().canCreateNewResources` boolean every §8 call
site already checks — this table is the source that boolean's computation
is derived from, not a second, separately-enforced concept.

---

## 14. UI

### `/settings/billing`

- **Current plan** + **status** (from the §13 table, rendered as a small
  status badge — reusing this app's existing `StatusBadge` component
  pattern already used for `ClientStatus`/`ProjectStatus`/etc., not a new
  bespoke badge component)
- **Trial days remaining** (only rendered while `status === "trialing"`)
- **Usage bars**: members, clients, projects, storage — each as a simple
  `current / max` bar (or "current, unlimited" text when `max` is `null`),
  reusing this app's existing plain hand-built component philosophy (no new
  charting library — `README.md` is explicit that this project uses zero
  UI/charting libraries anywhere)
- **Upgrade/downgrade** — a plan-comparison view (Starter vs. Pro,
  monthly/annual toggle) that routes into the §10 checkout flow (upgrade,
  or first subscribe) or the §11 Customer Portal (change plan on an
  existing subscription — the provider's own portal handles proration,
  never re-implemented here)
- **Manage billing** — link/redirect into the §11 Customer Portal
- **Cancel state**: if `cancelAtPeriodEnd` is true, show "Your subscription
  ends on {currentPeriodEnd}" with an explicit "Resume subscription" action
  (routes back into the Customer Portal)
- **Past-due banner**: per §13, rendered app-wide (not just on the billing
  page itself) while `status === "past_due"` — likely a persistent Header-
  level banner, the same visual precedent as this app's existing toast/
  banner conventions, not confined to `/settings/billing` since the whole
  point is the OWNER sees it wherever they are
- **Permissions**: the entire `/settings/billing` page 404s (not a
  permission-denied page — same "cross-user access looks identical to
  not-found" discipline `README.md`'s own Security section already states
  as this app's house style) for anyone who isn't the active org's `OWNER`
  — checked server-side via `getCurrentMembership()`, the page itself never
  renders for a `MEMBER`/`ADMIN` at all, mirroring how Comments' own
  moderation-delete permission or Team's own invite-form visibility already
  branch on role server-side first
- **Loading/error states**: standard Next.js `loading.tsx`/`error.tsx` for
  the route, matching every other dashboard route's existing convention
  (`clients/loading.tsx`, `(dashboard)/error.tsx`, etc. — nothing billing-
  specific needed here beyond following the pattern already established)

**Portal UI is not touched** — per the task's explicit instruction, and
consistent with §8's point that Client Portal users are never billing
subjects in this design at all.

---

## 15. Security

- **Webhook signature verification** — §12 already covers this as the
  first thing the handler does, before any other logic; restated here as a
  security-critical invariant, not just a correctness detail: an
  unverified webhook is a way for anyone on the internet to claim "this org
  is now on Pro" for free if signature checking is ever skipped or
  misconfigured.
- **No client-trusted plan** — the client's selected `PlanKey` (§10 step 2)
  is only ever a UI hint; the Server Action independently re-resolves the
  price ID from the server-side catalog (§6) by that key, and the actual
  entitlement (§7) is only ever set by a verified webhook (§12), never by
  anything the checkout-initiation request itself claims.
- **No client-supplied `organizationId` without server verification** —
  every billing Server Action resolves `organizationId` from
  `getCurrentMembership()` (session + Membership-backed, same as every
  other action in this app), never accepts one as a raw form/query
  parameter the way, for example, a URL could naively be crafted to pass
  one.
- **Checkout session scoped to OWNER + active org** — §10 step 3's
  `OWNER`-gate re-check, plus the `organizationId` attached to the Checkout
  Session at creation time being the *server-resolved* active org, never a
  client-supplied one — so even a maliciously crafted checkout-creation
  request can only ever start a checkout for the org the authenticated
  user's own session/Membership actually resolves to.
- **Price IDs allowlisted** — the catalog (§6) is the only source of valid
  price IDs; a Server Action never passes through an arbitrary client-
  supplied price ID string to the provider's Checkout Session API, even if
  a client-side plan-selection bug could otherwise produce one.
- **Open redirect protection** — checkout success/cancel return URLs are
  built server-side from this app's own known domain, never from a
  client-suppliable `redirectTo`-style parameter the way `sanitizeRedirectPath()`/
  `sanitizePortalRedirectPath()` already guard staff/portal login redirects
  in this codebase — the same discipline applies here, likely reusing those
  exact helpers rather than inventing new ones.
- **Secrets server-only** — the provider API key and webhook signing secret
  are read only in server-only modules (Server Actions, the webhook Route
  Handler), never in a `"use client"` file, matching this app's existing
  `check-no-public-secrets.mjs` automated check pattern, which a future
  `check-billing-security.mjs` extends.
- **Webhook replay** — covered by §12's idempotency (`WebhookEvent` unique
  constraint); a replayed-old-event is a no-op by the same mechanism that
  handles legitimate duplicate delivery, so "replay" and "duplicate" are
  the same defense, not two separate ones.
- **Duplicate checkout** — §10 step 7's "one active subscription per org"
  check, enforced before creating a second Checkout Session for an org that
  already has a non-terminal `Subscription`.
- **Cross-org billing access** — every read/write in this whole design goes
  through `organizationId` resolved from the authenticated user's own
  Membership (never a path parameter/query string naming an arbitrary org)
  — the exact same tenant-isolation discipline this app's Global Search
  feature was audited for (`docs/search-architecture.md`) and Comments/
  Attachments already rely on via their own `organizationId`-scoped
  queries.
- **Logs without PII/secrets** — §12 already states this for webhook
  logging specifically; applies equally to any billing-related error log
  anywhere in this design (never log a card-adjacent value, a customer
  email in a billing-error context beyond what's already normal app
  logging, a raw webhook payload, or a secret).

---

## 16. Taxes / legal / company boundary

**This section makes no legal claims as fact. Every statement here is
either (a) a description of what this codebase can technically do, or (b)
an explicit flag for a professional (accountant/lawyer) to confirm — never
both mixed together.**

### What's technically implementable now (Stages 2–6, all provider test/sandbox mode)

Everything in §5 through §15 — schema, entitlements, checkout, webhooks,
Customer Portal, UI, and the security properties around all of it — can be
fully built and fully tested against Paddle's (or Stripe's) sandbox/test
mode with zero legal prerequisites, because no real money or real tax
obligation is ever involved in test mode. This is exactly why the roadmap
(§20) puts live payments last (Stage 8), not first.

### What must not go into production (live) payments before a suitable business structure exists and provider eligibility is confirmed

- Actually charging a real customer a real amount.
- Actually enabling Paddle's (or Stripe's) live-mode API keys/price IDs in
  the production deployment.
- Marketing/advertising the product as "paid" anywhere real customers could
  act on it, before the above is resolved.

**This is a hard gate on Stage 8 specifically (§20)** — not a suggestion,
the roadmap section states it as a rule: "Do not connect live mode earlier
than Stage 8."

### Documents/data typically required — flagged for a professional, not asserted as complete or accurate

This document lists the *kind* of thing that is commonly required when
setting up a payment provider account and registering a business, purely
so nothing on this list comes as a surprise later — **this is not a
checklist to self-certify against; every item needs confirmation from an
accountant/lawyer and from the provider's own current documentation**:

- Whether Thai law requires a registered business entity (and what kind —
  sole proprietorship vs. a registered company) before this individual can
  lawfully sell a recurring SaaS subscription internationally, and at what
  revenue threshold (if any) that requirement changes.
- What tax registration (Thai VAT, and potentially registrations in
  customer countries depending on the MoR/non-MoR choice from §2) is
  required, and whether choosing an MoR provider (Paddle) genuinely removes
  the need for the seller's own cross-border VAT registration, or only
  reduces it — this document's §2 comparison describes the *general*
  MoR model's intent, not a confirmed outcome for this specific seller.
- Identity/KYC documents the chosen provider will require to activate a
  live-mode account (typically: government ID, proof of address, and,
  if a business entity exists, its registration documents) — provider-
  specific, must be checked at implementation time.
- Whether a Thai bank account (personal or business) is sufficient for
  payout, or whether the provider requires something else for this
  seller's country.

### What must be verified before Stage 8 specifically

1. Final confirmation of Paddle-vs-Stripe (§2) based on then-current,
   directly-sourced eligibility rules for this seller — not this document's
   snapshot comparison.
2. Confirmation from an accountant (ideally one familiar with cross-border
   digital services, not a generalist) on the actual Thai tax/business-
   registration obligations for this specific business model.
3. Confirmation the chosen provider's live-mode terms of service are
   actually accepted and the account is actually approved for live
   transactions, before flipping any env var from test to live price IDs
   (§6/§21).

---

## 17. Email / notifications

Built entirely on the existing Activity/Notification system (§0) — new
`NotificationType` enum values, new `NotificationRule` entries in
`notification-rules.ts`, new metadata builders in a new
`src/lib/activity/billing-metadata.ts` (mirroring `team-metadata.ts`/
`invoice-metadata.ts`'s existing per-domain split) — **not** a parallel
billing-specific notification pipeline.

### Events that notify the OWNER

| Event | New `NotificationType` | Recipient rule |
|---|---|---|
| Trial ending soon (e.g. 3 days left) | `TRIAL_ENDING` | The org's `OWNER` — resolved the same way `INVOICE_STATUS_CHANGED`'s rule already resolves "every OWNER/ADMIN," narrowed to `OWNER` only here since trial/payment is an OWNER-only concern per §11 |
| Payment failed | `PAYMENT_FAILED` | `OWNER` |
| Subscription activated (checkout succeeded, webhook confirmed) | `SUBSCRIPTION_ACTIVATED` | `OWNER` |
| Subscription canceled | `SUBSCRIPTION_CANCELED` | `OWNER` |
| Plan changed (upgrade/downgrade via Customer Portal) | `PLAN_CHANGED` | `OWNER` |

### Decisions

- **Uses the existing Notification Center**, not a separate billing-email
  system — every one of these becomes both an in-app `Notification` (bell
  dropdown, `/notifications`) and, per the existing per-type/per-channel
  `NotificationPreference` model, an email if the `OWNER` hasn't opted out
  and `RESEND_API_KEY`/`INVITATION_FROM_EMAIL` are configured (§0's
  existing graceful-degradation behavior, unchanged).
- **Email delivery**: reuses `deliverNotificationEmails()` exactly as-is —
  no new email-sending code path, only new templates
  (`src/lib/notifications/email/format-notification-email.ts` gains cases
  for the new types, mirroring how it already branches per `NotificationType`).
- **Cron reminders**: "trial ending in 3 days" is the one event in this
  list that isn't triggered by a webhook or a direct user action — it needs
  a daily check (§18) that finds orgs whose computed trial end (§9) falls
  within the reminder window and fires the notification once (idempotency
  here is "has this org already gotten a `TRIAL_ENDING` notification for
  this trial period" — a simple existence check against `Notification`
  rows, not a new dedicated table).
- **New `NotificationType` values needed**: `TRIAL_ENDING`,
  `PAYMENT_FAILED`, `SUBSCRIPTION_ACTIVATED`, `SUBSCRIPTION_CANCELED`,
  `PLAN_CHANGED` — five new enum values, added in Stage 2's migration
  alongside the billing models themselves (schema-only in that stage, per
  the exact same "schema first, fan-out hook second" staged pattern
  `MENTIONED`'s own rollout already used, per §0).

---

## 18. Cron / reconciliation

- **Webhook-first**: webhooks (§12) are the primary, near-real-time sync
  mechanism — cron is a backstop, never the primary path, exactly as §4
  already frames it.
- **Daily reconciliation job** (`/api/cron/billing-reconciliation`, same
  shape as the two existing cron routes — `requireCronAuth`, rate-limited,
  `force-dynamic`): for every org with a non-`canceled` local
  `Subscription`, re-fetch the true subscription state from the provider's
  API and correct any drift (a webhook that never arrived, or arrived and
  failed silently). **Read-and-repair only** — see below.
- **Trial-ending reminders**: the daily job (or a second, equally-daily job
  — Hobby plan's one-per-job-per-day cap, §0, means either combining this
  into the same daily run or accepting a second daily cron slot; both are
  compatible with the plan constraint, this is a Stage 2/18 implementation
  choice, not an architectural one) finds orgs whose trial ends within the
  reminder window (§17) and fires `TRIAL_ENDING` once per trial.
- **Stale subscription repair**: if reconciliation finds the provider says
  a subscription is `canceled` but the local row still says `active` (a
  missed webhook), the job corrects the local row — this is *repair*, not
  new information the app is otherwise blind to, and it's always the
  provider's own state winning, consistent with §4's source-of-truth rule.
- **No destructive automation without provider confirmation**: the
  reconciliation job **never** independently decides to cancel a
  subscription, revoke access, or delete data based purely on "we haven't
  heard from the provider in a while" — every state change it makes is
  because it *asked the provider directly* and got an authoritative answer,
  never because of an absence of webhook activity alone (which could just
  as easily mean "nothing changed" as "something changed and we missed
  it").
- **Hobby cron daily limit**: explicitly designed around from the start —
  every job in this design (reconciliation, trial reminders) is daily-
  cadence-compatible by nature (subscription drift and trial countdowns
  don't need minute-level freshness the way, say, a payment-processing
  queue would), so this project's existing Hobby-plan constraint (§0) is
  never actually a blocker for the billing cron design, unlike the
  notification-delivery retry job's own documented 15-30-minute *ideal*
  cadence that Hobby can't meet (a pre-existing, unrelated constraint noted
  in `README.md`/`docs/notifications-architecture.md` — billing
  reconciliation doesn't inherit that particular pain point).

---

## 19. Testing strategy

Mirrors this project's existing three-layer approach (`docs/testing.md`) —
unit (pure logic, no I/O), integration (real Prisma against real PGlite-
backed Postgres), E2E (real Chromium against a real production build) —
plus this project's fourth layer, static security checks.

### Unit

- Plan catalog: every `PlanKey` has both price IDs configured (§6's
  build-time consistency assertion, tested directly); limits are
  well-formed (no negative numbers, `null` only means "unlimited," never
  used for a numeric-limit field by accident).
- Entitlement mapping: `getOrganizationEntitlements()`'s pure computation
  (given a `Subscription` row shape + counts, does it produce the right
  `Entitlements` object) — tested with the DB layer mocked/stubbed out,
  the same "pure function, DOM/IO-free where possible" discipline this
  codebase already applies to `src/lib/search-ui/*`/`src/lib/comments/*`.
- State machine: every §13 status transition's derived
  `canCreateNewResources`/access-level boolean, exhaustively over every
  enum value (the TypeScript exhaustiveness §5 designed the enum for pays
  off directly here).
- Webhook event mapping: given a sample payload shape per event type
  (§12), does the handler compute the correct `Subscription` field
  updates — tested as pure transformation logic, separate from the
  idempotency/DB-write plumbing around it.
- Signature helper boundaries: valid signature accepted, invalid rejected,
  missing header rejected, tampered body rejected — mirroring how this
  project already unit-tests boundary conditions exhaustively for other
  security-relevant pure functions (e.g. `search-normalize-query.test.ts`'s
  own boundary coverage).
- Return URL validation: the open-redirect guard (§15) reusing/mirroring
  `sanitizeRedirectPath`'s own existing exhaustive test suite pattern
  (`//evil.com`, `/\evil.com`, embedded CR/LF, etc.).

### Integration

- Subscription persistence: a full webhook-handler call against the real
  PGlite-backed Postgres, asserting the resulting `Subscription`/
  `WebhookEvent` rows are exactly correct.
- Idempotent webhook: the same event delivered twice produces one
  `Subscription` state and one `WebhookEvent` row, not two.
- Out-of-order events: an older event delivered after a newer one is a
  no-op against the already-newer state.
- Limits: `getOrganizationEntitlements()` against real seeded data (real
  `Membership`/`Client`/`Project`/`Attachment` rows) at, under, and over
  each limit.
- Cross-org access: every billing Server Action, called with one org's
  session but attempting to reference another org's `Subscription`/
  `BillingCustomer`, is denied — same shape as this project's existing
  `test/integration/search/security.test.ts`'s own cross-org isolation
  suite.
- Downgrade behavior: an org over a new, lower plan's limits can still read/
  edit everything, but a new-creation attempt is correctly blocked.

### E2E

- Billing settings page: renders correctly per role (OWNER sees it,
  MEMBER/ADMIN get a 404 — §14), renders each §13 status's banner/CTA
  correctly (via seeded `Subscription` rows in different states, the same
  fixture-seeding pattern `test/fixtures/seed.ts` already uses for
  Organization/Membership fixtures).
- Checkout stub/test mode: drives the real Checkout-session-creation Server
  Action against the provider's own test/sandbox mode (both Stripe and
  Paddle support this) — **never a live charge in any automated test, ever**
  (explicit standing rule, not just a default).
- Webhook simulation: posts a real, correctly-signed test-mode webhook
  payload (signed with the same secret the test environment is configured
  with) at the actual webhook Route Handler and asserts the resulting DB
  state and UI reflect it on next page load.
- Trial expiry: a seeded org whose `Organization.createdAt` is set into the
  past (>14 days) correctly shows expired-trial behavior with no
  `Subscription` row needed.
- OWNER permissions: `/settings/billing` reachable and functional for
  OWNER, 404 for MEMBER/ADMIN, driven through real login as each role
  (mirroring this project's own recently-established pattern of driving
  role-based E2E checks through real Server Actions/real UI rather than
  fixture shortcuts, per the Global Search feature's own Stage 4/5 audits).
- Portal exclusion: a Client Portal identity has no billing UI reachable
  anywhere, and `/api` billing-adjacent routes (if any are ever portal-
  reachable at all, which §7/§8 currently say none are) reject a portal
  session exactly like `/api/search` already does today for portal
  sessions.

### Production verification

- Provider sandbox/test mode first, always — every check above runs
  against test-mode credentials in every environment up through and
  including a pre-live production deployment.
- **No live charge until explicit approval** — mirrors the standing rule
  this same engagement already followed for the Global Search feature's
  own production-verification stage (real fixtures, real flows, but never
  a destructive/live-money action without explicit, deliberate, separately-
  granted authorization) — billing's live-mode equivalent is even more
  consequential (real money, real customers) and gets at least that same
  level of deliberateness, gated by §16's legal/provider-readiness section
  and §20's Stage 8 gate.

---

## 20. Rollout stages

| Stage | Scope |
|---|---|
| **Stage 2** | Schema (`BillingCustomer`, `Subscription`, `WebhookEvent`, new `NotificationType` values), the code-based plan catalog (§6), `getOrganizationEntitlements()` (§7) — **no provider connection yet**, entitlements computable against seeded/test data only |
| **Stage 3** | Provider **test-mode** integration — API client setup, price/product creation in the provider's sandbox, catalog wiring to real (test-mode) price IDs, the build-time catalog-consistency check (§6) |
| **Stage 4** | Checkout flow (§10), webhooks (§12), Customer Portal (§11) — all against test mode only |
| **Stage 5** | Enforcement points (§8) wired into the real Server Actions, `/settings/billing` UI (§14), past-due banner, notifications (§17) |
| **Stage 6** | Full test suite (§19) across all four layers, plus a dedicated adversarial security audit of this feature specifically — mirroring the exact Stage-4-style audit process (PASS/WARNING/FAIL, severity-rated findings, re-audit after fixes) already used for Global Search and Comments & Mentions in this same project |
| **Stage 7** | Legal/provider readiness (§16) — accountant/legal consultation, provider live-mode application, KYC, confirming the final Stripe-vs-Paddle call against then-current real eligibility rules |
| **Stage 8** | Live payments — flip test-mode env vars/price IDs to live-mode ones, **only after Stage 7 is genuinely complete**, small-scale real-money verification before any real marketing/announcement |

**Live mode is never connected earlier than Stage 8.** Every prior stage is
fully buildable and fully testable without it.

---

## 21. Risks and open questions

- **No legal entity yet** — the single biggest blocker to Stage 8, tracked
  in full in §16; nothing in Stages 2-6 depends on it, but Stage 8 cannot
  start without it being resolved.
- **Provider country eligibility** (both as a seller for Thailand, and the
  set of supported customer countries) — flagged explicitly in §2 as a
  pre-implementation verification item, not settled by this document.
- **Tax/VAT** — §2/§16 already cover this at length; the open question that
  remains even after choosing an MoR provider is exactly *how much* of the
  compliance burden genuinely transfers away from this seller versus how
  much still requires the seller's own registration/reporting — a
  question for the accountant flagged in §16, not something this
  architecture can answer.
- **Migration from test to live price IDs** — mechanically simple (env var
  swap, §6/§20) but operationally risky if done carelessly: a checklist
  item for Stage 8 specifically should include verifying every `PlanKey`'s
  live-mode price IDs are configured and active *before* flipping the
  environment, given §6's own build-time check only validates internal
  consistency, not that the live-mode IDs actually resolve to real,
  correctly-priced provider objects (that needs the integration test
  described in §6/§19, re-run against live-mode credentials specifically
  once they exist).
- **Webhook reliability** — §4/§12/§18 already design multiple layers of
  defense (idempotency, ordering guards, daily reconciliation), but the
  residual risk of "a webhook that never arrives and reconciliation hasn't
  run yet" (up to ~24h staleness window on Hobby-plan daily cron) should be
  explicitly accepted as a known v1 trade-off, not discovered as a surprise
  later — a Pro-plan cron upgrade (§0/§18) would shrink this window if it
  ever becomes a real problem.
- **Downgrade semantics** — §3/§7/§8 define the "block new creation only,
  never touch existing data" rule clearly, but the actual *product*
  decision of exactly which limits to enforce and at what numbers (§3's
  placeholder pricing table) remains genuinely open and is explicitly not
  something this architecture document settles.
- **Support/refund process** — this document designs the technical refund
  *mechanism* (§2's comparison table, provider APIs support it natively)
  but not the *policy* (how many days, under what conditions, who approves
  one) — an operational/business decision, not an architectural one, and
  currently undefined.
- **Chargebacks** — §2 already notes Paddle's MoR model changes who
  directly bears chargeback-handling burden, but this document does not
  design any in-app chargeback-specific UI/notification beyond what a
  generic `subscription.canceled`/`past_due` transition already covers —
  worth revisiting once real chargeback volume (if any) shows whether a
  dedicated flow is actually needed.
- **Data retention after cancellation** — §3/§13 establish that this app
  never deletes an org's data purely because its subscription canceled
  (existing data stays fully readable indefinitely under §13's "canceled =
  read-only" row) — but this document does not define a hard data-deletion
  policy for a canceled-and-never-returning org (e.g. "delete after 2 years
  of inactivity"), which is a genuinely open product/legal question, not
  resolved here, and interacts with whatever data-retention obligations
  emerge from §16's own legal review.

---

## Stage 2 implementation note

Stage 2 (schema, plan catalog, entitlements, and enforcement — see the
Stage 2 report for the full account) implemented this document's design
with one deliberate refinement, made explicit here since it changes what
§5/§9 originally proposed:

- **No `BillingCustomer` model.** §5's original proposal was evaluated
  against Stage 2's own instruction to skip it unless a real independent
  lifecycle justified it — since this schema already enforces one
  `Subscription` row per `Organization` (`organizationId` unique), a
  provider customer id has no lifecycle a separate table would add any
  value over. `providerCustomerId`/`providerSubscriptionId` live directly
  on `Subscription` instead.
- **Trial provisioning is explicit, not implicit.** §9 originally proposed
  no `Subscription` row at all for a trialing org (computed from
  `Organization.createdAt` alone); Stage 2 instead creates a real
  `TRIALING` `Subscription` row atomically with every new `Organization`
  (`src/lib/billing/provisioning.ts`), per that stage's own explicit
  instruction.

**Status as of Stage 2: a provider-neutral foundation only.**
- No payment provider is connected — no SDK, no API client, no webhook
  route, no checkout, no customer portal.
- No `/settings/billing` page or any other billing UI exists yet.
- Live billing is not enabled, and cannot be from this stage's code alone.
- Paddle-vs-Stripe eligibility for this seller (§2) is still an open,
  unverified pre-implementation item — nothing in Stage 2 depends on it,
  and nothing in Stage 2 should be read as confirming it either way.

---

## Stage 3 implementation note

Stage 3 built the staff-only Billing page and its provider-neutral
placeholder actions directly on top of Stage 2's foundation, with no
changes to Stage 2's schema, plan catalog, access-mode state machine, or
enforcement contracts.

**Route and permissions.** `src/app/(dashboard)/settings/billing/page.tsx`
sits behind the existing `(dashboard)` layout's own staff-only guard — no
new authorization code was needed at that layer. The page itself renders
for every staff role (OWNER/ADMIN/MEMBER); only OWNER sees enabled
plan-management controls. ADMIN/MEMBER get the *same* read-only
presentation: every management button (`Upgrade`/`Downgrade`/`Manage
subscription`) still renders, always visible, but `disabled`, with a
one-line explanation ("Only the organization owner can manage billing.")
— chosen over hiding the buttons entirely, so a non-owner can see what
exists without being told nothing is there. The Server Actions
independently re-check role server-side regardless of what the client
renders; the disabled attribute is a UX affordance, never the
authorization boundary.

**View-model, not recomputed semantics.** `getBillingPageData()`
(`src/lib/billing/view-model.ts`) is the single server-side function the
page and its components render from — it calls the existing
`getOrganizationEntitlements()` (never reimplements plan/status/usage
logic) and layers two small, additive-only reads on top, neither of which
touches Stage 2's own contracts: a `PENDING` Invitation count (so the
Members usage row can show the same number that actually constrains
`canInviteMember`, mirroring — not duplicating — `entitlements.ts`'s own
internal pending-invite math) and the raw Subscription row's
`currentPeriodEnd`/`cancelAtPeriodEnd` (fields `OrganizationEntitlements`
never exposed, since Stage 2's enforcement never needed them).

**Provider-neutral placeholder actions (§8's "choose one option, justify
it").** `requestPlanChangeAction`/`manageSubscriptionAction`
(`src/app/(dashboard)/settings/billing/actions.ts`) are real, enabled,
OWNER-only Server Actions — not disabled buttons with static text. They
run the full intended flow (role check → plan validation against the
catalog's `billingAvailable` flag → provider-availability check) and
return a controlled `{ ok: false, message: "Billing provider is not
configured." }` result with zero side effects: no Subscription/WebhookEvent
write, no Activity/Notification row. The reasoning: a disabled button
demonstrates nothing, while these actions demonstrate the entire
end-to-end shape a real Stage 4 provider integration will have — the only
code Stage 4 needs to add is what happens once
`getBillingProviderAvailability()` reports `configured: true`, not a
rewrite of the authorization/validation path.

**Provider availability is a swappable seam.**
`getBillingProviderAvailability()` (`src/lib/billing/provider-availability.ts`)
always returns `{ configured: false, provider: "PADDLE", checkoutAvailable:
false, portalAvailable: false }` in Stage 3 — no env var read, no attempt
to detect a real Paddle config (there isn't one). Every caller (the
view-model, both placeholder actions) goes through this one function, so
Stage 4 wiring a real provider check in is a one-file change.

**Unknown plan key: two independent safety nets, one real.** Stage 2's
`buildOrganizationEntitlements()` already normalizes any
`Subscription.planKey` it doesn't recognize to `LEGACY` before Stage 3's
view-model ever sees it — so a real, corrupted-data DB row renders as the
Legacy plan, not a crash (verified end-to-end in
`test/e2e/billing-ui.spec.ts`). The view-model's own `PLAN_CATALOG` lookup
additionally falls back to a generic "Custom plan" label rather than
throwing on `undefined` — defense-in-depth for a hypothetical caller that
bypasses `getOrganizationEntitlements()` entirely (exercised directly in
`test/unit/billing-view-model.test.ts`), not a path any real request can
currently reach.

**No new middleware, no new global blocker.** Access-mode banners
(FULL_ACCESS/LIMITED_WRITES/READ_ONLY) render only on the Billing page
itself — existing Stage 2 server-side enforcement is unchanged and remains
the only place writes are actually blocked.

**Status as of Stage 3: foundation + UI, still no live payments.**
- No payment provider is connected — no SDK, no checkout/webhook/
  customer-portal route, no real price IDs, no new env vars.
- The Billing page and its placeholder actions are real and fully
  wired, but every provider-facing action returns a controlled
  "not configured" result with no side effects.
- Live billing is not enabled, and cannot be from this stage's code alone.
- See `docs/operator-setup.md` for what a future operator must still
  connect before any of this becomes live billing.

---

## Stage 4 implementation note

Stage 4 built the provider-neutral integration shell this document always
intended §12/§8 to sit behind — a typed adapter contract, a registry, a
full deterministic mock, and the real webhook route — without connecting
any real payment provider. Full detail (adapter contract, mock behavior,
webhook sequence, environment variables, and the test-mode → live
checklist) now lives in its own document:
**[`docs/billing-provider-adapter.md`](billing-provider-adapter.md)** —
this note only records what changed relative to this document's own
original design and Stage 2/3's contracts.

**One additive migration, confirmed necessary and user-approved before
being written.** `docs/notifications-architecture.md`-style staged
`NotificationType` rollout (§17 above) said these four values would be
added "in Stage 2's migration alongside the billing models themselves" —
Stage 2 did not actually do this. Stage 4 needed real Notification rows
for billing events, so it added a second, purely-additive migration
(`prisma/migrations/20260907100000_add_billing_notification_types/`) for
exactly `SUBSCRIPTION_ACTIVATED`, `PAYMENT_FAILED`, `SUBSCRIPTION_CANCELED`,
`PLAN_CHANGED` — nothing removed or renamed, generated and verified only
against a disposable local PGlite instance, never applied to any shared/
production database. `TRIAL_ENDING` (§17's fifth value) is still deferred
— it needs a daily cron job this stage doesn't build (see
`docs/operator-setup.md`).

**Billing notifications bypass the Activity-driven fan-out pipeline.**
§17 above described billing notifications as "built entirely on the
existing Activity/Notification system." In practice, `createActivity()`/
`dispatchNotificationsForActivity()` are keyed by
`(ActivityEntityType, ActivityAction)` — a webhook event has no human
actor and no existing `ActivityEntityType` fits "a Subscription changed."
Rather than add a second, unconfirmed enum surface (a new
`ActivityEntityType`/`ActivityAction` pair) purely to shoehorn a
system-triggered event into an actor-shaped audit log, Stage 4 writes
`Notification` rows directly (`src/lib/billing/notify.ts`), with
`activityId`/`entityType`/`entityId` all left `null` — precisely the
"system-triggered notification, no Activity behind it" shape
`Notification.activityId`'s own schema comment already anticipated for
exactly this situation. No Activity row is created for any billing event;
`Notification` alone is the owner-visible surface that matters here.

**Historical snapshot — status as it stood when Stage 4 shipped (before
Sale-Ready Phase E), provider-neutral integration shell, still no live
payments.** This bullet list describes what was true at that point in
time, not the current state of `main` — see "Current state" immediately
below for what's true today.
- No real Paddle/Stripe SDK, no real API keys, no real webhook secret, no
  real price IDs — `BILLING_PROVIDER`/`BILLING_API_KEY`/
  `BILLING_WEBHOOK_SECRET`/`BILLING_STARTER_PRICE_ID`/`BILLING_PRO_PRICE_ID`
  exist only as empty placeholders in `.env.example`, read by no code.
- A full TEST_MODE-only mock provider makes the entire checkout →
  webhook → Subscription-update → Notification pipeline exercisable
  end-to-end in tests, with zero network calls and zero payment data
  collected — see `docs/billing-provider-adapter.md`.
- Outside TEST_MODE, every checkout/portal action and the webhook route
  fail closed with a controlled, generic response — the exact same
  "Billing provider is not configured." UI state Stage 3 already shipped.
- Live billing is still not enabled, and still cannot be from this
  stage's code alone — see `docs/billing-provider-adapter.md`'s own
  test-mode → live checklist for what a real provider connection
  actually requires.

**Current state (Sale-Ready Phase E, E2.2–E2.6 — all merged to `main`).**
The provider-neutral design above is exactly what got built, and it's no
longer just a shell:
- A real Paddle adapter exists (`@paddle/paddle-node-sdk` server-side,
  `@paddle/paddle-js` for the checkout overlay) — real checkout, real
  Customer Portal, real signature-verified/idempotent webhook
  processing. Full detail: `docs/billing-provider-adapter.md` (kept
  current through every E2.x stage).
- The provider registry (`getBillingProviderAdapter()`) activates this
  real adapter automatically once a complete, valid Paddle configuration
  is present, and still fails closed to the unconfigured adapter
  otherwise — the exact fail-closed behavior described above is
  unchanged, it's just no longer the *only* reachable outcome.
- **This repository still contains no real Paddle account, credentials,
  KYC/KYB, or payout information** — none of the above required the
  current maintainer to create one. A future buyer supplies all of that
  themselves; see `docs/operator-setup.md`'s Billing section for the
  exact remaining steps.
- Real signature verification and checkout have been built and tested
  against Paddle's own current, real documentation and a fully mocked
  SDK client, but have never been exercised against an actual Paddle
  sandbox account — see `docs/billing-provider-adapter.md`'s own "Open
  questions" section.
