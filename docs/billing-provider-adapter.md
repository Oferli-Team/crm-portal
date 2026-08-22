# Billing Provider Adapter — Handoff Guide

Written for whoever eventually connects a real payment provider (Paddle or
Stripe) to this app. It explains the adapter contract Stage 4 built, how
the TEST_MODE-only mock implements it, exactly what a real implementation
needs to do differently, and the checklist for going live. **No real API
keys, secrets, or price IDs are included anywhere in this document.**

See also: [`docs/billing-architecture.md`](billing-architecture.md) (the
overall design) and [`docs/operator-setup.md`](operator-setup.md) (the
practical "what's left" checklist).

## Why this exists

Stages 1–3 built a local, provider-neutral billing foundation
(`Subscription`/`WebhookEvent` schema, plan catalog, entitlements,
enforcement, and a Billing UI) with no payment provider connected at all.
Stage 4 built the *shape* every future provider integration plugs into —
a typed adapter interface, a registry that resolves to either a real
adapter or a safe stand-in, a deterministic mock that exercises the full
checkout → webhook → Subscription-update pipeline in tests, and a
provider-neutral webhook route. Connecting Paddle or Stripe for real is
now a matter of implementing one interface and wiring a few environment
variables — no changes to entitlements, the Billing UI, or the webhook
route's own trust/idempotency/ordering logic.

## Implementation status (Sale-Ready Phase E)

- **E2.2** — `src/lib/billing/provider/paddle-config.ts`: reads and
  validates the env vars below (fail-closed on any partial config).
- **E2.3** — `src/lib/billing/provider/paddle-provider.ts`:
  `createCheckoutSession` and `createCustomerPortalSession` implemented
  against the actual Paddle Transactions API and Customer Portal
  Sessions API (via the official `@paddle/paddle-node-sdk`).
- **E2.4 (this PR)** — the same file's `verifyWebhook`/
  `parseWebhookEvent` are now **real implementations** too, replacing
  E2.3's fail-closed placeholders:
  - `verifyWebhook` performs real `Paddle-Signature` HMAC-SHA256
    verification (`ts=<unix>;h1=<hex>`, signed string `${ts}:${rawBody}`,
    plain `node:crypto`, timing-safe comparison) with a **30-second**
    timestamp tolerance (`PADDLE_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`)
    and accepts a match against any `h1` value present (Paddle's own
    secret-rotation format sends more than one while a secret is being
    rotated on Paddle's side). Deliberately does **not** use the SDK's
    own combined `webhooks.unmarshal()` helper — this app's adapter
    contract is a separate verify-then-parse pair, not one combined
    call.
    - **Why 30s, not Paddle's own literal 5-second SDK default:** found
      during E2.4 PR review that the 5-second default has a real,
      documented false-rejection history —
      [PaddleHQ/paddle-node-sdk#30](https://github.com/PaddleHQ/paddle-node-sdk/issues/30)
      reports it rejecting genuinely valid deliveries, resolved for that
      integrator by widening to 10 seconds. This app's own deployment
      target (a Vercel serverless Next.js route) is exactly the kind of
      environment where cold start plus normal network latency can
      plausibly eat a multi-second chunk of a 5-second budget before
      Paddle's own delivery latency is even considered. 30 seconds stays
      inside the commonly cited "5-30 seconds is a reasonable range" for
      this kind of check. This is a small concession given the webhook
      route's own independent, unconditional idempotency guard (a real
      `P2002` unique-constraint catch on `WebhookEvent.providerEventId`)
      — a replayed-but-still-within-tolerance event can never be
      reapplied even once accepted here, so this constant's real job is
      rejecting a *stale* signed payload, not being the sole anti-replay
      control.
  - `parseWebhookEvent` parses the raw body as JSON and normalizes the
    subscription lifecycle events below into `NormalizedBillingEvent`.
    See "Supported and ignored webhook events" below for the full list.
  - Both remain pure/synchronous (no network, no DB) and never log the
    raw body, signature header, or webhook secret.
- **E2.5 (this PR)** — closes the two remaining checkout-flow gaps E2.4's
  own report flagged. `createCheckoutSession` no longer returns Paddle's
  own `transaction.checkout.url` at all — it now returns this app's own
  `/billing/checkout` bridge page URL (carrying the new transaction's
  id), which opens a Paddle.js overlay checkout for that exact
  transaction. `input.returnUrl`/`cancelUrl` are now actually used —
  threaded through to the bridge page, which passes `returnUrl` to
  Paddle.js as `settings.successUrl` (absolute, resolved against the
  browser's own origin) and navigates to `cancelUrl` itself when the user
  closes the overlay without paying (`checkout.closed`). See "The
  checkout bridge" below for the full architecture and reasoning. Adds
  one new dependency, `@paddle/paddle-js` (the official, client-side,
  TypeScript-typed Paddle.js wrapper — never the server-side
  `@paddle/paddle-node-sdk`), imported only by the bridge page, and one
  new, deliberately public environment variable,
  `NEXT_PUBLIC_BILLING_CLIENT_TOKEN` (see "Required environment
  variables" below).
- **E2.6 (this PR) — the provider registry is now active.**
  `getBillingProviderAdapter()` (`./provider.ts`) resolves, strictly in
  this order: (1) `TEST_MODE` → the mock adapter, taking priority over a
  real Paddle config even if one is also present; (2) otherwise,
  `getPaddleProviderConfig()` — a fully valid config → the real
  `createPaddleBillingProvider(config)`; (3) anything else (nothing set,
  one var missing, an invalid value) → the fail-closed unconfigured
  adapter. `provider.ts` itself never reads a `BILLING_*` variable
  directly and never assembles its own config object — the only config
  ever passed to the real adapter is whatever `getPaddleProviderConfig()`
  itself returned. See "The registry" below for the exact code. Resolving
  the adapter still makes no network call of its own — confirmed against
  the installed `@paddle/paddle-node-sdk`'s own source that its `Paddle`
  constructor only stores the API key/options and builds resource
  wrapper objects (no `fetch`, no `await`, anywhere in it); every actual
  Paddle API request happens lazily, later, only when a specific adapter
  method is actually called by a real checkout/portal action.
- **Platform Admin's own "Mode" display now distinguishes Sandbox from
  Live.** `src/lib/billing/platform-billing-config.ts`'s `PlatformBillingConfig
  .mode` (rendered on `/platform-admin/configuration`) is now `"Test"` |
  `"Sandbox"` | `"Live"` | `"Not configured"` — before E2.6, `"paddle"`
  was an adapter `kind` this code could never actually reach, so it
  collapsed straight to `"Live"`; now that it's reachable, that would have
  misleadingly shown "Live" for a Paddle account correctly configured in
  its own `sandbox` (test-money) environment. The distinction is derived
  from `getPaddleProviderConfig()`'s own non-sensitive `environment`
  field — this page still never reads or displays `apiKey`,
  `webhookSecret`, any price id, or the client token.
- **No Paddle account was created or required for this PR** — every
  test uses a fully mocked SDK client, stubbed env vars, and a locally
  computed signature; no network call is ever made, confirmed by a
  dedicated test that fails the build if `fetch` is ever called while
  resolving the adapter. Per the sale-ready framing established in E2.2:
  real credentials are still supplied later, by whoever actually
  connects a Paddle account — never by this repository.

**Even with E2.6, this is not a sandbox-verified payment flow yet** —
every checkout-flow gap E2.3/E2.4/E2.5 identified is now closed in code,
*and* the resolver can now genuinely activate the real adapter given a
complete, valid config — but neither the webhook signature verification
nor the checkout bridge's own Paddle.js call has ever been exercised
against a real Paddle sandbox account. Both are built and tested against
locally-computed fixtures / a fully mocked SDK client / stubbed env
vars, matching Paddle's own current, real documentation as closely as
this PR could verify without creating an account. See "Open questions"
below for the specific remaining gaps.

## The adapter contract

`src/lib/billing/provider/types.ts` defines `BillingProviderAdapter`:

```ts
interface BillingProviderAdapter {
  readonly kind: "mock" | "unconfigured" | "paddle";
  readonly name: BillingProvider; // "PADDLE"

  createCheckoutSession(input: BillingCheckoutSessionInput): Promise<BillingCheckoutSession>;
  createCustomerPortalSession(input: BillingPortalSessionInput): Promise<BillingPortalSession>;
  verifyWebhook(input: WebhookVerificationInput): WebhookVerificationResult;
  parseWebhookEvent(rawBody: string): NormalizedBillingEvent | null;
}
```

Everything crossing this boundary is already normalized to this app's own
vocabulary — no Paddle- or Stripe-specific type, field name, or status
string is allowed to leak past `src/lib/billing/provider/*` (enforced by
`scripts/security-checks/check-billing-security.mjs`). A real
`Subscription.status` cancellation flow, a Paddle `subscription.canceled`
event, and a Stripe `customer.subscription.deleted` event all become the
exact same `NormalizedBillingEvent` shape by the time anything outside
this directory ever sees one.

There is deliberately no `cancelSubscription`/`resumeSubscription` method
on this interface — the current UI never calls a provider API directly to
cancel; "Manage subscription" redirects to the provider's own hosted
Customer Portal, and this app only ever learns the result via a webhook.
Add such a method later only if a genuine in-app "Cancel now" button ships
— it would be a compatible, additive interface change.

### `verifyWebhook` reads headers, not a single string

`WebhookVerificationInput` carries the full `Headers` object, not one
pre-extracted signature string — different providers sign with different
header names entirely (Paddle: `Paddle-Signature`, Stripe:
`Stripe-Signature`). Keeping header-name knowledge inside each adapter is
what keeps `src/app/api/billing/webhook/route.ts` itself genuinely
provider-neutral: it never needs to know which header any given provider
uses.

## The checkout bridge (E2.5, Paddle adapter)

**Why Paddle.js is required, not a plain server redirect.** Paddle
Billing has a separate, sales-team-gated "Hosted Checkout" feature that
would let `createCheckoutSession` return a URL the browser could be
redirected to directly, with no Paddle.js on this app's own side at
all — but that feature requires emailing sellers@paddle.com for
approval and is live-accounts-only, not something guaranteed available
to every future buyer's self-serve Paddle account. The overlay checkout
built here (`Paddle.Checkout.open({ transactionId })`, via the official
`@paddle/paddle-js` wrapper) is the standard, self-serve, officially
documented path every real Paddle Billing integration uses — gated only
on the ordinary domain-approval step every Paddle.js integration needs
regardless of which specific checkout flow is used (auto-approved on
Paddle's sandbox; usually fast/automatic on live, see "Test-mode → live
checklist" below).

**Architecture.** `requestPlanChangeAction` → `adapter
.createCheckoutSession()` → `{ url }` → `redirect(url)` is completely
unchanged as a contract (`src/app/(dashboard)/settings/billing/actions.ts`).
What changed is what that `url` actually points to:

1. `paddle-provider.ts`'s `createCheckoutSession` creates a real Paddle
   Transaction exactly as before (E2.3), then builds a same-origin URL
   to this app's own new page, `src/app/billing/checkout/page.tsx`
   (`buildCheckoutBridgeUrl`), carrying the transaction's own `id`
   (always present and non-nullable per the SDK's own `Transaction`
   type — deliberately not `transaction.checkout.url`, which is
   nullable and, per the above, only resolves to a working page under a
   separate, uncertain setup step), this adapter's own configured
   `sandbox`/`live` environment, and the already-sanitized
   `returnUrl`/`cancelUrl` (see `BillingCheckoutSessionInput`'s own doc
   comment in `types.ts` — already sanitized/allowlisted by the caller
   before ever reaching this adapter).
2. The browser is redirected to that bridge page — still fully on this
   app's own domain the entire time, never a cross-origin navigation at
   any point up to this line.
3. The bridge page (`"use client"`) re-validates every query param as
   untrusted input (`src/app/billing/checkout/checkout-bridge.ts`'s own
   `resolveCheckoutBridgeParams` — pure, fails closed, unit-tested; it's
   a public route, reachable with an arbitrary query string, so nothing
   from the URL is trusted just because the happy-path caller always
   sends well-formed values), loads `@paddle/paddle-js`, calls
   `initializePaddle({ environment, token: NEXT_PUBLIC_BILLING_CLIENT_TOKEN })`,
   then `paddle.Checkout.open({ transactionId, settings: { successUrl } })`
   — an overlay rendered directly on top of this same page, never a
   further navigation away from this app's own domain.
4. **Success:** Paddle.js itself redirects the top-level browser window
   to `settings.successUrl` (the sanitized `returnUrl`, resolved to an
   absolute URL against the browser's own origin) once payment
   completes inside the overlay.
5. **Close/cancel:** if the user closes the overlay without completing
   payment, the bridge page's own `eventCallback` catches Paddle.js's
   `checkout.closed` event and does an in-app `router.push(cancelPath)`
   back to `/settings/billing?checkout=cancel`.

**Subscription activation is still never triggered by this page or by
either redirect target.** Neither this page nor `requestPlanChangeAction`
ever touches `Subscription`; the only thing this whole bridge does is
get the browser to Paddle's overlay and back. The existing
`?checkout=success` notice on `/settings/billing`
(`src/app/(dashboard)/settings/billing/page.tsx`, Stage 4, unchanged by
E2.5) already covers "the user came back before the real webhook
did" — it was written generically enough for exactly this case, so E2.5
needed no new pending-state UI. Real state changes only ever happen via
`src/app/api/billing/webhook/route.ts`, unchanged by E2.5.

**Trust boundary.** The bridge page is deliberately a public route with
no auth check — it makes no trust decision of its own. `transactionId`
is an opaque string only ever passed through to Paddle.js; the
transaction it refers to already carries whichever organization's
`custom_data.organizationId` `createCheckoutSession` embedded
server-side, before this page was ever reached. `requestPlanChangeAction`
(the only real caller) already fully authorizes (OWNER-only,
server-resolved org) before ever creating the transaction or
redirecting here — nothing in this app's own security model depends on
who is looking at the bridge page.

## Supported and ignored webhook events (E2.4, Paddle adapter)

Paddle's own `event_type` string → this app's normalized
`BillingProviderEventType` (`src/lib/billing/provider/types.ts`), as
implemented by `paddle-provider.ts`'s `parseWebhookEvent`:

| Paddle `event_type` | Normalized as |
|---|---|
| `subscription.created` | `SUBSCRIPTION_CREATED` |
| `subscription.activated` | `SUBSCRIPTION_ACTIVATED` |
| `subscription.updated` | `SUBSCRIPTION_UPDATED` |
| `subscription.resumed` | `SUBSCRIPTION_UPDATED` |
| `subscription.trialing` | `SUBSCRIPTION_UPDATED` |
| `subscription.canceled` | `SUBSCRIPTION_CANCELED` |
| `subscription.past_due` | `SUBSCRIPTION_PAST_DUE` |
| `subscription.paused` (or `status: "paused"` on any other event) | `EVENT_IGNORED` |
| `subscription.imported` | `EVENT_IGNORED` |
| any other `subscription.*` event | `EVENT_IGNORED` |
| any non-`subscription.*` event (e.g. `transaction.*`, `customer.*`) | `EVENT_IGNORED` |

`EVENT_IGNORED` is a normal, successfully-parsed result (recorded for
idempotency/audit, never acted on) — distinct from `null`, which
`parseWebhookEvent` returns only for a payload that can't be parsed at
all (not valid JSON, or missing `event_id`/`event_type`/`occurred_at`,
or a `subscription.*` event with no `data` object).

**Why no `transaction.*` events are mapped:** re-reading
`src/app/api/billing/webhook/route.ts` before writing this PR confirmed
that its `PAYMENT_FAILED` notification is driven entirely by the
`becamePastDue` status transition (i.e. `subscription.past_due`), with
no dependency on any transaction-level event at all. Adding
`transaction.payment_failed`/`transaction.completed` mapping would be
unused scope, not a missing feature — payment failure is already
covered end to end.

**Why no dedicated `PAUSED`/`UNPAID` status:** this app's own
`SubscriptionStatus` enum has no `PAUSED` value (deliberately, "provider-
conditional, not needed for v1") — any event carrying `status: "paused"`
is ignored regardless of which `event_type` carried it, never coerced
into a different status. Paddle's own subscription status vocabulary is
confirmed to have exactly 5 values (`trialing`, `active`, `past_due`,
`paused`, `canceled`) — there is no Paddle event that can ever produce
`SubscriptionStatus.UNPAID`; a `status` value this app doesn't
recognize (there currently are none among Paddle's real values, since
`paused` is filtered out before the status map is even consulted) maps
to `status: null` rather than being fabricated.

**`cancelAtPeriodEnd`** is derived from `subscription.updated` payloads
whose own `data.scheduled_change.action === "cancel"` — Paddle only
fires `subscription.canceled` once a cancellation actually takes effect,
not when it's merely scheduled, so this is the only way to learn a
cancellation is pending.

**Trust boundary:** `parseWebhookEvent` only normalizes data — it never
queries the database, never mutates `Subscription`, and treats
`organizationId` (read from `data.custom_data.organizationId`) as an
unverified claim, never authoritative. Validating that claim against
the database, and rejecting an unknown organization or a provider id
already bound to a different org, stays entirely in the webhook route,
unchanged by this PR.

## The registry

`src/lib/billing/provider/provider.ts` (E2.6 — active):

```ts
export function getBillingProviderAdapter(): BillingProviderAdapter {
  if (TEST_MODE) {
    return createMockBillingProvider();
  }

  const config = getPaddleProviderConfig();
  if (config) {
    return createPaddleBillingProvider(config);
  }

  return createUnconfiguredBillingProvider();
}
```

Every checkout/portal Server Action and the webhook route call this —
never construct an adapter any other way. `getBillingProviderAvailability()`
(`src/lib/billing/provider-availability.ts`) derives the Billing UI's
`configured`/`checkoutAvailable`/`portalAvailable` flags from
`adapter.kind` — the UI never has its own opinion about whether a
provider is connected. Neither the webhook route nor either checkout/
portal Server Action changed for E2.6 — both were already fully
provider-neutral (they only ever call `getBillingProviderAdapter()` and
branch on the returned adapter's own `kind`/methods), so a real,
correctly-configured Paddle adapter flows through automatically.

**Priority order, and why:** `TEST_MODE` is checked first and
unconditionally wins, even when a full, valid Paddle config also happens
to be present in the environment — a local/test environment must never
be able to accidentally talk to a real Paddle account just because its
own `.env` also has billing vars set for some unrelated reason (a real
scenario a solo/dev environment can easily end up in). `getPaddleProviderConfig()`
is Stage 2's own all-or-nothing validator (see "Required environment
variables" below) — there is no partial-config state: either every one
of the six required variables is present and valid, or the resolver
never calls `createPaddleBillingProvider` at all and falls through to
the fail-closed unconfigured adapter. `provider.ts` never reads a
`BILLING_*` variable itself and never constructs a config object of its
own — enforced by dedicated security checks (`check-billing-security.mjs`,
checks 24/30/31), not just this doc's own description of the intent.

## The mock provider

`src/lib/billing/provider/mock-provider.ts` — a full, deterministic,
TEST_MODE-only stand-in. It:

- makes zero network calls;
- stores no card/payment data (there is none to store — it never collects
  a card number, email, or billing address at all);
- derives `providerCustomerId`/`providerSubscriptionId` deterministically
  from `organizationId` (`deriveMockCustomerId`/`deriveMockSubscriptionId`)
  rather than randomly, so tests can assert on them without capturing a
  generated value first;
- signs its own webhook payloads with a fixed, TEST_MODE-only HMAC secret
  (`signMockWebhookPayload`) — never a real secret, never read from an env
  var, and (via a second, independent `if (!TEST_MODE) throw` guard at
  construction) never reachable outside TEST_MODE even if the registry
  were ever miswired.

Two TEST_MODE-only pages simulate what a real provider's hosted checkout/
Customer Portal would do — `src/app/billing/mock/checkout/page.tsx` and
`src/app/billing/mock/portal/page.tsx`. Both 404 unconditionally outside
TEST_MODE (`if (!TEST_MODE) notFound()`, checked before anything else —
including before any dynamic API call, and both pages export `dynamic =
"force-dynamic"` specifically so this check re-runs on every request
instead of being baked into a static 404 at build time). Neither page —
nor any Server Action behind it — ever writes to `Subscription` directly;
every simulated outcome (checkout success, cancel, simulated payment
failure) builds and signs a real event, then POSTs it to the real
`/api/billing/webhook` route, the exact same path a genuine provider
delivery takes.

## The webhook route

`src/app/api/billing/webhook/route.ts` — provider-neutral, no user
session dependency. Sequence:

1. Read the raw body exactly once.
2. Resolve the adapter; an unconfigured provider fails closed (400, no
   DB write) before anything else.
3. `adapter.verifyWebhook(...)` — invalid signature → 400, no DB write.
4. `adapter.parseWebhookEvent(...)` — unparseable → 400, no DB write.
5. Resolve and trust-validate the event's claimed `organizationId`
   (must exist; its provider customer/subscription ids must not already
   belong to a *different* org's `Subscription` row).
6. Idempotency: `prisma.webhookEvent.create(...)` with a real unique
   constraint on `providerEventId` — a `P2002` here means "already
   received," a safe no-op, never reprocessed. This is a real
   insert-and-catch, not a check-then-insert race.
7. `applyBillingEventToSubscription(...)` (`src/lib/billing/event-mapper.ts`,
   a pure function) decides whether to apply, ignore, or reject — an
   event whose own `providerUpdatedAt` doesn't advance past the row's
   last-applied one is ignored, never regresses state.
8. On `APPLY`: one transaction updates `Subscription`, marks the
   `WebhookEvent` row `PROCESSED`, and creates any relevant
   `Notification` row(s) for the org's OWNER — all together, so one
   event's failure can never leave things half-updated.
9. Best-effort email delivery runs after the transaction commits (the
   same `deliverNotificationEmails()` every other notification-producing
   flow in this app already uses — no new email code path).

Never logs the raw payload, a signature, or any provider secret. Never
stores the raw payload on `WebhookEvent` (that table has no such column,
by design — see `docs/billing-architecture.md` §5).

## Local Subscription mapping

`src/lib/billing/event-mapper.ts`'s `applyBillingEventToSubscription` is
pure — no I/O, fully unit-tested (`test/unit/billing-event-mapper.test.ts`)
against every `SubscriptionStatus`, plan changes, `cancelAtPeriodEnd`,
grace-period computation (7 days, set once on first entry into
`PAST_DUE`, preserved on repeats, cleared on recovery), unknown plan keys
(stored verbatim — `entitlements.ts` already treats any unrecognized
value as LEGACY-safe), and the old-event ordering guard. It never touches
the entitlement engine directly — `getOrganizationEntitlements()`
continues to just read whatever `Subscription` row this mapper's output
was used to write.

## Required environment variables

Documented as empty placeholders in `.env.example` — see that file's own
comments. **Sale-Ready Phase E, E2.2** added
`src/lib/billing/provider/paddle-config.ts`, which reads and validates
the six server-only variables below. **As of E2.6**,
`getBillingProviderAdapter()` (`./provider.ts`) actually calls this
module and activates the real Paddle adapter once every one of the six
is present and valid (see "The registry" above) — so, in a real
deployment (`TEST_MODE` off), setting all six for real is exactly what
turns Paddle on. This repository itself never sets any of them for
real — no Paddle account exists here, and none of these placeholders
have ever been filled with a real value in this codebase:

| Variable | Purpose |
|---|---|
| `BILLING_PROVIDER` | Which real provider is configured. Must be exactly `PADDLE` (matching the `BillingProvider` Prisma enum's own casing) — anything else, `paddle-config.ts` treats Paddle as entirely unconfigured. |
| `BILLING_ENVIRONMENT` | Which Paddle mode these credentials are for — exactly `sandbox` or `live`, nothing else accepted (never guessed, never defaulted). The Paddle Node SDK requires this explicitly at client construction; it cannot be inferred from the API key alone. |
| `BILLING_API_KEY` | The provider's server-side API key. Server-only — never `NEXT_PUBLIC_`. |
| `BILLING_WEBHOOK_SECRET` | Used by the real adapter's `verifyWebhook` to compute/compare the provider's actual signature. Server-only. |
| `BILLING_STARTER_PRICE_ID` | The real provider price id for the `STARTER` plan (`src/lib/billing/plans.ts`'s `PLAN_CATALOG.STARTER`). |
| `BILLING_PRO_PRICE_ID` | Same, for `PRO`. |

**Sale-Ready Phase E, E2.5** adds one more, deliberately different in
kind from the six above:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_BILLING_CLIENT_TOKEN` | Paddle's own dedicated **client-side token** (created and managed in Paddle > Developer tools > Authentication) — explicitly documented by Paddle as safe for a browser bundle. Used only by `src/app/billing/checkout/page.tsx` to call `Paddle.Initialize()`/`initializePaddle()`; cannot be used to call any server-side Paddle API, and is a **completely different credential** from `BILLING_API_KEY`. This is the one and only billing/provider variable this project ever gives a `NEXT_PUBLIC_` prefix — `scripts/security-checks/check-billing-security.mjs` allowlists exactly this one and rejects any other. |

`scripts/security-checks/check-billing-security.mjs` already fails the
build if any variable other than `NEXT_PUBLIC_BILLING_CLIENT_TOKEN` (any
of the six server-only ones above, or any future billing/provider
variable) is ever given a `NEXT_PUBLIC_` prefix — `paddle-config.ts`
lives under `src/lib/billing/provider/`, so it's automatically covered
by that same script's existing "every file here is server-only" and "no
console logging here" checks too, with no new assertions needed there.
Separately, `BILLING_API_KEY`/`BILLING_WEBHOOK_SECRET` are checked by
name to never be referenced in any `"use client"` file at all, prefix or
not (E2.5's own check).

**All seven values are supplied later, by whoever actually connects a
real Paddle account — never by this repository.** This project is
designed to be sold as a SaaS foundation: the current owner does not
create a Paddle account, does not go through KYC/KYB, does not supply
any payout/banking information, and does not enter any real credentials
here — this repository contains code, placeholders, and a configuration
contract, nothing account-specific. A future buyer creates their own
Paddle account (sandbox first, then live), completes their own KYC/KYB
and payout setup with Paddle directly (entirely outside this
repository), creates their own client-side token alongside their API
key/webhook secret/price ids, fills in their own values for these seven
variables in their own deployment's environment, and registers their
own webhook endpoint — with zero application code changes required. No
real key, secret, price id, or client token belongs in this file,
`.env.example`, or any other committed file, ever (a client-side token
is not itself highly sensitive — Paddle documents it
as browser-safe — but this repository still never commits a *real* one,
same as every other placeholder here).

`getPaddleProviderConfig()` (`paddle-config.ts`) treats any single
missing or invalid value — including an unrecognized `BILLING_ENVIRONMENT`
— as "Paddle is not configured" (returns `null`), never a partial or
best-effort configuration.

### Where plan → price id mapping belongs

`src/lib/billing/plans.ts`'s `PLAN_CATALOG` is the single source of truth
for plan *limits* and stays a code-defined, deploy-reviewed constant —
never a runtime database edit (see that file's own header comment). A
real adapter's `createCheckoutSession` is the one place that maps a
`planKey` to a real provider price id, reading
`BILLING_STARTER_PRICE_ID`/`BILLING_PRO_PRICE_ID` — this mapping should
live inside the adapter implementation itself (e.g.
`src/lib/billing/provider/paddle-provider.ts`'s own small
`PRICE_ID_BY_PLAN_KEY` lookup), not inside `plans.ts`, which must stay
provider-agnostic.

## Required provider metadata

When a real adapter creates a checkout session, it must embed the
organization id as trusted, provider-echoed metadata (Paddle's
`custom_data`, Stripe's `metadata`) so the webhook can recover which
`Organization` a delivered event is about. This is exactly what
`NormalizedBillingEvent.organizationId` is for — a real adapter's
`parseWebhookEvent` reads it out of the provider's own payload and
returns it as a claim; the webhook route (not the adapter) is what
validates that claim against the database before ever applying it (see
"The webhook route" above). Never accept an organization id from
anywhere else in a webhook payload.

## Open questions (sandbox-only validation gaps)

Everything above is confirmed against Paddle's own current, real
documentation and quoted example payloads — not assumed. What remains
genuinely unverified, because this PR (like E2.2/E2.3 before it) uses no
real Paddle account and makes no network call:

- **Real signature delivery.** `verifyWebhook` is tested against
  locally-computed HMAC fixtures built the same way Paddle's own docs
  describe the algorithm, but has never been exercised against an actual
  webhook delivered by Paddle's own infrastructure (header casing,
  transport-level body encoding, etc., in practice rather than in
  documentation). Recommended first live step once a sandbox Paddle
  account exists: point a sandbox webhook endpoint at this route and
  confirm a real delivery verifies successfully before trusting this in
  production.
- **`subscription.resumed`/`subscription.trialing` in practice.** Their
  existence and rough shape are confirmed by Paddle's docs, but no real
  example payload for either was available to fetch during this PR
  (unlike `created`/`updated`/`canceled`/`activated`, which were
  verified against real quoted examples). The mapping (`SUBSCRIPTION_
  UPDATED`) is conservative and should be safe regardless of minor field
  differences, but hasn't been sandbox-confirmed field-by-field.
- **`status: "unpaid"`.** Confirmed absent from Paddle's real status
  enum today; flagged here only so this stays a checked fact rather than
  a silent assumption if Paddle's own API ever changes.
- **The checkout bridge's own Paddle.js call (E2.5).** `Paddle.Checkout
  .open({ transactionId, settings: { successUrl } })` and the
  `checkout.closed` event are both confirmed against Paddle's own
  current documentation and the `@paddle/paddle-js` package's own real,
  installed TypeScript types (not guessed) — but, like the webhook
  signature above, has never actually been opened against a real Paddle
  sandbox transaction. Recommended first live step once a sandbox Paddle
  account and client-side token exist: run a real checkout end to end
  and confirm the overlay opens, completes, and redirects correctly.
- **Domain approval.** Paddle.js requires the hosting domain to be
  approved in Paddle's own dashboard (Checkout > Website approval) —
  automatic on Paddle's sandbox, but on live accounts this can be a
  manual review (Paddle's own docs cite an estimated 5-7 business days
  in some cases). A future buyer should start this step early, before
  attempting a live checkout, per Paddle's own recommendation.

## Test-mode → live checklist

Steps 1-2 and 5 (choosing/confirming Paddle, implementing the adapter,
and wiring it into the registry) are already done as of E2.6 — nothing
further needed there for a future buyer. What remains is entirely
buyer-supplied configuration and testing, never a code change:

1. ~~Choose and confirm provider eligibility (Paddle vs. Stripe)~~ —
   done: this codebase is built specifically against Paddle (see
   `docs/billing-architecture.md` §2/§16 for the original comparison).
2. ~~Implement `createPaddleBillingProvider()` against
   `BillingProviderAdapter`~~ — done (E2.2-E2.5).
3. Create a real Paddle account (sandbox first) and add the real
   environment variables (above, all seven — including
   `NEXT_PUBLIC_BILLING_CLIENT_TOKEN`) to the deployment — never commit
   them. As soon as all six server-only variables are valid, the
   registry activates the real adapter automatically — no code change,
   no redeploy of application code needed, just the environment.
4. Request domain approval for the deployment's own domain in Paddle >
   Checkout > Website approval (auto-approved on sandbox; start this
   early on live per Paddle's own recommendation — see "Open questions"
   above).
5. ~~Add the real provider as a third branch in
   `getBillingProviderAdapter()`~~ — done (E2.6, this section's own "The
   registry" above).
6. Point the provider's real webhook configuration at
   `/api/billing/webhook` (this app's route needs no change).
7. Test against the provider's own test/sandbox mode end to end — real
   checkout through `/billing/checkout`'s own Paddle.js overlay, real
   webhook delivery, confirm `Subscription` updates and `Notification`s
   fire exactly as the mock already proved they would. **Not yet done by
   this repository** — see "Open questions" above; this is the first
   genuinely required manual step before trusting any of this in
   production.
8. Only after that: flip to live-mode credentials/price ids/client
   token. Treat this as a deliberate, reviewed deploy step, never an
   automatic migration — see `docs/operator-setup.md`'s own "Live
   payments" section.

## Security checklist (already enforced today)

Everything below is verified by `scripts/security-checks/check-billing-security.mjs`
(run via `npm run security:check`) — a real provider implementation must
keep every one of these true:

- Every file under `src/lib/billing/provider/` is server-only.
- No `NEXT_PUBLIC_` billing/provider environment variable anywhere.
- No console logging of the webhook route or provider adapter directory
  (a raw payload/signature/secret must never reach a log line).
- The webhook route verifies the signature before ever parsing the
  payload, with no `TEST_MODE`-gated bypass of its own.
- Idempotency via a real database unique-constraint catch, not a
  check-then-insert race.
- The event mapper's `providerUpdatedAt` ordering guard.
- Checkout/portal actions are OWNER-only, and never accept
  `organizationId`/`userId`/`providerCustomerId`/`providerSubscriptionId`
  as a parameter from any caller.
- Return/cancel URLs are only ever built through `sanitizeRedirectPath`.
- The mock provider and both mock UI pages are unreachable outside
  TEST_MODE.
- No hardcoded provider price/product id literal anywhere in `src/`.
- The webhook route validates organization existence and rejects
  cross-org provider id reuse.
- The Client Portal never imports any part of the Billing UI or `src/lib/billing`.
- (E2.4) `paddle-provider.ts`'s `verifyWebhook` is a real HMAC-SHA256
  implementation, not a placeholder that always fails closed.
- (E2.4) `paddle-provider.ts`'s `parseWebhookEvent` is a real
  implementation, not a placeholder that always returns `null`.
- (E2.5) `@paddle/paddle-js` is only ever imported from
  `src/app/billing/checkout/`, never anywhere else in `src/` — and only
  ever by a file that starts with `"use client"`.
- (E2.5) `BILLING_API_KEY`/`BILLING_WEBHOOK_SECRET` are never referenced
  by name in any `"use client"` file — a stricter, name-specific check
  than the `NEXT_PUBLIC_` prefix rule above.
- (E2.5) No `NEXT_PUBLIC_` billing/provider variable other than exactly
  `NEXT_PUBLIC_BILLING_CLIENT_TOKEN`.
- (E2.6) The provider registry activates the real Paddle adapter only
  via `getPaddleProviderConfig()` — never a hardcoded or
  inline-object-literal config passed to `createPaddleBillingProvider`.
- (E2.6) `provider.ts` never reads a `BILLING_*` env var directly (by
  `process.env` access or literal name) — only `paddle-config.ts` does.
- (E2.6) `provider.ts` never hand-assembles its own Paddle config object
  (no `apiKey:`/`webhookSecret:`/`priceIdByPlanKey:` field name in the
  file).
- (E2.6) The `TEST_MODE` branch appears before the Paddle-activation
  branch in `provider.ts`'s own source — `TEST_MODE` always takes
  priority.
- (E2.6) The fail-closed unconfigured provider fallback is still
  imported and still referenced in `provider.ts`.
- (E2.6) `getBillingProviderAdapter()` stays fully synchronous — no
  `async`/`await`/`fetch(` anywhere in `provider.ts`.
