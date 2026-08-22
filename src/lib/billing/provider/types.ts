import "server-only";
import type { BillingProvider, SubscriptionStatus } from "@/generated/prisma/enums";

/**
 * Billing & Subscriptions Stage 4 (docs/billing-architecture.md, this
 * stage's own §2). The provider-neutral contract every adapter
 * implementation (mock, unconfigured, and a future real Paddle/Stripe one)
 * satisfies. Nothing outside `src/lib/billing/provider/*` may reference a
 * Paddle- or Stripe-specific type, field name, or status string — every
 * value crossing this boundary is already normalized to this app's own
 * vocabulary (see `event-mapper.ts` for where a normalized event becomes a
 * `Subscription` row).
 *
 * `server-only` at the top: nothing here may ever reach a client bundle —
 * checked by scripts/security-checks/check-billing-security.mjs.
 */

export type BillingCheckoutSessionInput = {
  /** Server-resolved active organization — never client-supplied. */
  organizationId: string;
  /** Already validated against the plan catalog's `billingAvailable` flag by the caller. */
  planKey: string;
  /** Already sanitized/allowlisted by the caller (src/lib/safe-redirect.ts). */
  returnUrl: string;
  /** Already sanitized/allowlisted by the caller. */
  cancelUrl: string;
  /** Reused if this organization already has one — never creates a second provider customer for the same org. */
  existingProviderCustomerId: string | null;
};

export type BillingCheckoutSession = {
  /** Where to redirect the browser to complete checkout. */
  url: string;
};

export type BillingPortalSessionInput = {
  organizationId: string;
  providerCustomerId: string;
  /** Already sanitized/allowlisted by the caller. */
  returnUrl: string;
};

export type BillingPortalSession = {
  url: string;
};

export type WebhookVerificationInput = {
  /** Read exactly once by the caller (the webhook Route Handler) and handed here — an adapter must never re-read the request itself. */
  rawBody: string;
  /**
   * The full request headers, not a single pre-extracted signature string —
   * different providers sign with a different header name entirely
   * (Paddle: `Paddle-Signature`, Stripe: `Stripe-Signature`, the mock:
   * its own fixed header). Keeping header-name knowledge inside each
   * adapter (rather than the route handler picking one) is what keeps the
   * route genuinely provider-neutral — it never needs to know which
   * header any given provider uses.
   */
  headers: Headers;
};

export type WebhookVerificationResult = { verified: true } | { verified: false; reason: string };

/**
 * Minimal, provider-neutral internal event vocabulary (this stage's own
 * §8). No dedicated "plan changed" event type: a real provider (and the
 * mock) surfaces a plan change as an ordinary SUBSCRIPTION_UPDATED event
 * whose planKey differs from the row's current one — the webhook handler
 * is what notices the difference and fires a PLAN_CHANGED *notification*,
 * which is a distinct, app-level concept from this event-type union. No
 * SUBSCRIPTION_RESUMED either: this stage's UI contract never surfaces an
 * in-app "resume" action (§8's own "only if a real UI contract needs it"
 * — it doesn't here), so it's left out rather than added speculatively;
 * adding it later is a compatible, additive union member. EVENT_IGNORED is
 * what `parseWebhookEvent` returns for an event type this app deliberately
 * never acts on — still a normal, successfully-parsed result (never a
 * parse failure), recorded for idempotency/audit and nothing more.
 */
export type BillingProviderEventType =
  | "SUBSCRIPTION_CREATED"
  | "SUBSCRIPTION_ACTIVATED"
  | "SUBSCRIPTION_UPDATED"
  | "SUBSCRIPTION_CANCELED"
  | "SUBSCRIPTION_PAST_DUE"
  | "SUBSCRIPTION_UNPAID"
  | "EVENT_IGNORED";

/**
 * The one shape every adapter's `parseWebhookEvent` normalizes a raw,
 * provider-specific payload into. Deliberately does not carry the raw
 * payload itself past this point (this stage's own §8 "never pass raw
 * payload beyond the adapter boundary" rule) — only the specific fields
 * `event-mapper.ts`'s pure mapper needs.
 *
 * `organizationId` is a *claim* read out of the provider's own echoed-back
 * metadata (never trusted outright) — the webhook route is what actually
 * verifies the claimed organization exists and that the provider
 * customer/subscription ids aren't already bound to a *different* org
 * before this event is ever applied (this stage's own §9).
 */
export type NormalizedBillingEvent = {
  type: BillingProviderEventType;
  /** The provider's own idempotency key — maps directly to WebhookEvent.providerEventId. */
  providerEventId: string;
  /** The provider's own "when this happened" timestamp — distinct from providerUpdatedAt below (see event-mapper.ts's ordering guard). */
  providerCreatedAt: Date;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  /** Unverified claim — see this type's own doc comment. */
  organizationId: string | null;
  /** A raw string, not yet validated against the plan catalog — event-mapper.ts stores it verbatim; entitlements.ts already treats any unrecognized value as LEGACY-safe. */
  planKey: string | null;
  status: SubscriptionStatus | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean | null;
  trialEnd: Date | null;
  /** The event-ordering guard's own comparison field — see event-mapper.ts. */
  providerUpdatedAt: Date;
};

/** A discriminant every adapter exposes so callers (the provider-availability seam, security checks) never need a runtime type-check against a concrete class. */
export type BillingProviderKind = "mock" | "unconfigured" | "paddle";

export interface BillingProviderAdapter {
  readonly kind: BillingProviderKind;
  readonly name: BillingProvider;

  createCheckoutSession(input: BillingCheckoutSessionInput): Promise<BillingCheckoutSession>;
  createCustomerPortalSession(input: BillingPortalSessionInput): Promise<BillingPortalSession>;

  /** Pure/synchronous by contract — no adapter implementation may make a network call to verify a signature. */
  verifyWebhook(input: WebhookVerificationInput): WebhookVerificationResult;

  /** Returns `null` only for a payload this adapter cannot parse at all (malformed) — an event type it recognizes but never acts on is `{ type: "EVENT_IGNORED", ... }`, not `null`. Must never receive an unverified payload — callers always call `verifyWebhook` first. */
  parseWebhookEvent(rawBody: string): NormalizedBillingEvent | null;
}

/**
 * Deliberately excluded from `BillingProviderAdapter`: a direct in-app
 * "cancel"/"resume" action that calls the provider's API. Stage 4's own UI
 * contract never needs one — plan changes go through checkout, and
 * cancellation happens on the provider's own hosted Customer Portal (§6),
 * with this app only ever learning about the result via a webhook. Adding
 * a `cancelSubscription`/`resumeSubscription` method later (a real in-app
 * "Cancel now" button) is a compatible, additive interface change, not a
 * reason to add one speculatively now.
 */
