# Operator Setup

Notes for whoever eventually operates a real deployment of this project —
what's already built, what still needs connecting, and what's deliberately
left undone. Covers **Billing**, **Storage**, and **Platform Admin**
today; other sections will be added here as they become relevant.

No real credentials, keys, or account-specific values are included
anywhere in this document. Every value below is a placeholder to fill in
from your own provider account.

## Storage (Supabase buckets)

File Attachments and organization logos require two Supabase Storage
buckets to exist in your own Supabase project. The application never
creates them automatically — `getStorageAdminClient()`
(`src/lib/storage/admin-client.ts`) only connects to Storage with the
service-role key, it never provisions a bucket — so this is a one-time
manual step per Supabase project.

| Bucket name (exact) | Visibility | Used by | Constraints |
|---|---|---|---|
| `attachments` | **Private** | `src/lib/storage/attachments-storage.ts` — Client/Project/Task attachments, served only via short-lived (60s) signed URLs | 10 MB/file, 20 files per entity, allowlisted MIME types (`src/lib/storage/attachments-config.ts`): PDF, PNG/JPEG/WebP, TXT/CSV, DOC/DOCX/XLS/XLSX — no SVG/HTML/executables/archives, on purpose |
| `logos` | **Public** | `src/lib/storage/logo-storage.ts` — organization logo, rendered via a permanent public URL | 2 MB/file, PNG/JPEG/WebP only (`src/lib/storage/logo-config.ts`) |

To create them: in the Supabase dashboard, **Storage → New bucket**,
using those exact names, with `attachments` left private and `logos`
marked public.

**No Storage RLS policies need to be written.** Both buckets are
accessed exclusively through a server-side client authenticated with
`SUPABASE_SERVICE_ROLE_KEY` (`getStorageAdminClient()`), which bypasses
Storage RLS entirely — the same trust boundary `prisma/seed.ts` already
uses for the Auth Admin API. That key is server-only and never reaches
the browser.

Until both buckets exist, attachment/logo uploads fail with a
controlled `not_configured`/`bucket_missing`-style result — the rest of
the app keeps working.

## Platform Admin bootstrap

`/platform-admin` is a read-only console for whoever operates this
deployment — separate from any tenant's own Organization/Membership.
Access is controlled entirely by one env var,
**`PLATFORM_ADMIN_EMAILS`** (`src/lib/platform-admin/authorization.ts`):
a comma-separated, case-insensitive allowlist of Supabase Auth email
addresses, e.g. `PLATFORM_ADMIN_EMAILS="you@example.com,teammate@example.com"`.

To get yourself access on a fresh deployment:

1. Sign up for a normal account through the app's own `/signup` flow,
   using an email address you control — this creates your Supabase Auth
   user (no special step needed).
2. Add that same email to `PLATFORM_ADMIN_EMAILS` in your deployment's
   environment variables.
3. Redeploy — this is a build/runtime env var read fresh on each
   request, but Vercel only picks up a changed env var on a new
   deployment, not automatically.
4. Visit `/platform-admin` while signed in with that email.

Unset (the default) means nobody has access — an unauthenticated
request to `/platform-admin/*` redirects to `/login` (the same sign-in
redirect every protected route uses), and a signed-in but non-matching
email redirects silently to `/dashboard`, never revealing that the
route exists. This grants read access across **every** organization on the
deployment, so keep the list limited to people who actually operate the
platform. No real personal email belongs in this file or any other
committed file — only ever set as a real deployment's own env var.

## Billing

See [`docs/billing-architecture.md`](billing-architecture.md) for the full
design and [`docs/billing-provider-adapter.md`](billing-provider-adapter.md)
for the adapter contract, mock behavior, and the exact test-mode → live
checklist. This section is the practical "what do I still need to do"
summary for an operator, not a repeat of either document.

### What's already implemented

- A local, provider-neutral `Subscription`/`WebhookEvent` schema, a typed
  plan catalog (`src/lib/billing/plans.ts`), organization entitlements
  (`src/lib/billing/entitlements.ts`), and server-side limit enforcement on
  staff invites, Client/Project creation, and Attachment uploads.
- A staff-only Billing page (`/settings/billing`) showing current plan,
  status, usage, and Starter/Pro plan cards — all sourced from the local
  database.
- A **provider-neutral adapter contract** (`src/lib/billing/provider/*`)
  that a real Paddle/Stripe integration implements against, plus a
  registry (`getBillingProviderAdapter()`) that resolves to it — see
  `docs/billing-provider-adapter.md`.
- A **real checkout flow** (`requestPlanChangeAction`) and **real
  Customer Portal flow** (`manageSubscriptionAction`) — owner-only,
  server-resolved organization, allowlisted plan keys, safe return URLs,
  reused provider customer ids. Both redirect to whatever the resolved
  adapter's session URL is; neither ever writes to `Subscription` itself.
- A **real, provider-neutral webhook route**
  (`POST /api/billing/webhook`) — signature verification, idempotency,
  event-ordering guard, cross-org id-conflict protection, and atomic
  `Subscription`/`Notification` updates. Fully built and tested. As of
  Sale-Ready Phase E, E2.6, it's reachable by the real Paddle adapter
  automatically whenever a complete, valid Paddle configuration is
  present (see "What's still pending" below) — the TEST_MODE-only mock
  provider remains the only thing that reaches it in this repository's
  own development/test environment, since no real Paddle account exists
  here.
- A **full, deterministic mock provider**, active only when
  `TEST_MODE=1` (a flag this app already only ever sets for its own E2E
  test runs — never in a real deployment). Makes zero network calls,
  collects zero payment data, and exercises the entire checkout →
  webhook → Subscription-update → Notification pipeline for real. Two
  TEST_MODE-only pages (`/billing/mock/checkout`, `/billing/mock/portal`)
  simulate what a provider's hosted pages would do; both 404
  unconditionally in any real deployment.
- Billing events (subscription activated, payment failed, subscription
  canceled, plan changed) notify the organization's OWNER through the
  existing in-app Notification Center and email, with the same
  graceful-degradation behavior every other notification type already
  has (see "Notifications" below).
- Every organization created so far — including ones created before
  billing existed — resolves to a safe access mode (`FULL_ACCESS` for a
  pre-billing/legacy org, a real trial/paid state for a new one). Nothing
  in the current code degrades an existing organization's access.

### What's still pending — connecting a real Paddle account

As of Sale-Ready Phase E, E2.6, the *implementation* is complete and
*wired in*: a real Paddle adapter (`@paddle/paddle-node-sdk`,
`@paddle/paddle-js`) exists, and the provider registry
(`getBillingProviderAdapter()`) activates it automatically once a
complete, valid configuration is present — no further application code
changes are needed. What's still pending is entirely **buyer-supplied
account and configuration**, never a code change:

1. **A real Paddle account.** The architecture doc recommends Paddle
   (Merchant of Record) over Stripe; this codebase is built specifically
   against Paddle. Confirming product/country eligibility and reviewing
   with an accountant before going live remains a real, business-specific
   step only the account holder can do (see `docs/billing-architecture.md`
   §2/§16) — this repository does not and cannot resolve that for you.
2. **Real credentials and price IDs.** `BILLING_PROVIDER`,
   `BILLING_ENVIRONMENT`, `BILLING_API_KEY`, `BILLING_WEBHOOK_SECRET`,
   `BILLING_STARTER_PRICE_ID`, `BILLING_PRO_PRICE_ID`, and
   `NEXT_PUBLIC_BILLING_CLIENT_TOKEN` are listed, empty, in
   `.env.example`. Setting every one of them to a real, valid value
   activates the real adapter immediately; any single one missing/
   invalid fails closed to "not configured" — see
   `docs/billing-provider-adapter.md`'s own env-var table and checklist
   for exactly where each value comes from in the Paddle dashboard. No
   price/product ID is ever hardcoded anywhere in this codebase. The six
   server-only variables must never be given a `NEXT_PUBLIC_` prefix
   (`scripts/security-checks/check-billing-security.mjs` guards against
   that mistake); the seventh, `NEXT_PUBLIC_BILLING_CLIENT_TOKEN`, is
   Paddle's own dedicated client-safe token and is the one deliberate
   exception.
3. **The Paddle account's own webhook configuration.** Point Paddle's
   webhook settings at `POST /api/billing/webhook` — the route itself
   needs no change.
4. **Paddle's own domain-approval step.** Required before Paddle.js
   checkout will actually work on your domain — auto-approved on
   sandbox, see `docs/billing-provider-adapter.md`'s checklist for live.
5. **Trial-ending reminders (`TRIAL_ENDING`).** Deliberately not built —
   optional, defense-in-depth only. Trial expiry is already enforced
   independent of any notification (`src/lib/billing/access-mode.ts`),
   and the Billing page already shows "Trial ends on [date]" passively.
   The other four billing notification types
   (activated/payment-failed/canceled/plan-changed) are already live,
   webhook-triggered.
6. **Reconciliation cron.** `docs/billing-architecture.md` §18 designs a
   daily "re-fetch from the provider and correct drift" job as a
   webhook-delivery backstop — deliberately not built. Not required for
   webhooks to work correctly (idempotency and event-ordering are both
   already unconditional); only a defense-in-depth backstop for the rare
   case a delivery is permanently lost, and meaningfully validating it
   requires a real Paddle account anyway.

**None of the above requires the current maintainer of this codebase to
create a Paddle account, enter credentials, complete KYC/KYB, or provide
payout/banking information** — every item is either a one-time buyer
action with their own Paddle account, or explicitly optional.

### Notifications

Billing events already flow through the existing Notification Center —
no separate email pipeline. In production with no email provider
configured (`RESEND_API_KEY`/`INVITATION_FROM_EMAIL` unset), the
in-app `Notification` row is still created; email delivery is recorded as
`SKIPPED`/`not_configured` rather than failing, and webhook processing
itself always succeeds regardless of email configuration — the same
graceful-degradation behavior every other notification type in this app
already has.

### Migration and backfill

- Two billing-related migrations exist —
  `prisma/migrations/20260830090000_add_billing_foundation/` (Stage 2:
  the `Subscription`/`WebhookEvent` schema) and
  `prisma/migrations/20260907100000_add_billing_notification_types/`
  (Stage 4: four additive `NotificationType` enum values). **Both have
  been applied to production** (Sale-Ready Phase E, E1) — verified
  directly against the production database via `prisma migrate status`:
  all 22 migrations report applied, schema up to date, the billing
  foundation migration present, no migrations pending.
- `prisma/backfill-subscriptions.ts` (idempotent, dry-run by default) gives
  every pre-existing organization an explicit `LEGACY` Subscription row
  instead of relying indefinitely on the "no row = legacy access" fallback.
  **Verified against production** (Sale-Ready Phase E, E1): a dry run
  reported `Organizations without a Subscription row: 0` — every
  organization already has one, so `--apply` was not needed and no write
  was performed.
- Production runtime was confirmed healthy after this verification —
  including after an unrelated Supabase database password rotation (see
  the security note below) — with a real staff session reaching
  `/dashboard` and `/clients` with no Prisma connection errors.

### Security note — handling production database credentials

Operating against the production database (checking migration status,
running the backfill script) requires `DATABASE_URL`/`DIRECT_URL`
locally, per the [README's own Environment variables table](../README.md#environment-variables)
(Supabase → Project Settings → Database → Connection string). A few
rules, reinforced by an actual incident during Sale-Ready Phase E, E1:

- Production secrets must never be printed to a shell, logged, or pasted
  into a chat/AI session — not even partially. If one is exposed this
  way regardless, treat it as compromised and rotate it immediately, the
  same as if it had been committed to git.
- A local file holding real production credentials (e.g.
  `.env.production.local`) stays gitignored (`.env*` is ignored except
  `.env.example`/`.env.test.example`) and should be deleted once the
  task that needed it is done.
- After rotating the database password in Supabase, **both** Vercel's
  stored `DATABASE_URL`/`DIRECT_URL` (Project Settings → Environment
  Variables) **and** any local `.env*` file must be updated to match —
  and production must be redeployed afterward, since a running
  deployment does not pick up an env var change without a new build.
  Until both are done, production will fail every database query with
  Prisma error `P1000` ("Authentication failed against the database
  server").

### Live payments

Live billing is disabled by construction — there is no code path in this
repository that can currently charge a real customer or reach a real
payment provider. It stays that way until a real adapter is implemented
and connected per `docs/billing-provider-adapter.md`'s own checklist, and
is deliberately turned on.
