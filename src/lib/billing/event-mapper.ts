import type { SubscriptionStatus } from "@/generated/prisma/enums";
import type { NormalizedBillingEvent } from "./provider/types";

/**
 * Billing & Subscriptions Stage 4 (docs/billing-architecture.md §13, this
 * stage's own §11). Pure — no I/O, no Prisma import reachable from this
 * function's own call graph, the same discipline access-mode.ts and
 * entitlements.ts already established in Stage 2. Takes an already-
 * normalized event (provider-neutral, already signature-verified by the
 * caller) plus the *resolved* organization's own existing Subscription
 * row (or `null`), and decides what to write — or not write.
 *
 * Deliberately does NOT decide whether the event's claimed organization is
 * trustworthy (does it exist? does the provider customer/subscription id
 * already belong to a *different* org?) — those are DB-dependent checks
 * this function has no way to make, and they live in the webhook route
 * instead (src/app/api/billing/webhook/route.ts), which calls this
 * function only after already resolving a trusted organizationId.
 *
 * Never mutates the entitlement engine directly (src/lib/billing/
 * entitlements.ts) — that layer only ever reads whatever Subscription row
 * this mapper's output was used to write, unchanged from Stage 2.
 */

/** 7 days, per docs/billing-architecture.md §3/§5/§13 — set once, the moment a subscription first enters PAST_DUE; never extended by a repeated PAST_DUE event for the same lapse. */
export const GRACE_PERIOD_DAYS = 7;

/** The subset of a Subscription row this mapper actually needs — mirrors entitlements.ts's own SubscriptionStateForEntitlements narrowing, so this function's own tests never need to construct an entire fake row. */
export type SubscriptionRowForMapping = {
  planKey: string;
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  gracePeriodEndsAt: Date | null;
  providerUpdatedAt: Date | null;
};

/** Every field this mapper decides a caller should write to the Subscription row — deliberately excludes organizationId/trialStartedAt/trialEndsAt, which the route resolves/preserves itself (see this file's own header comment). */
export type SubscriptionUpsertData = {
  planKey: string;
  status: SubscriptionStatus;
  providerCustomerId: string;
  providerSubscriptionId: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  gracePeriodEndsAt: Date | null;
  providerUpdatedAt: Date;
};

export type ApplyBillingEventOutcome =
  | { outcome: "APPLY"; data: SubscriptionUpsertData; planChanged: boolean }
  | { outcome: "IGNORE_EVENT_TYPE" }
  | { outcome: "IGNORE_OLDER_EVENT" }
  | { outcome: "REJECT_MISSING_ORGANIZATION" }
  | { outcome: "REJECT_MALFORMED" };

/**
 * Boundary timestamps are treated inclusively-toward-ignore (an event
 * whose own `providerUpdatedAt` exactly equals the row's last-applied one
 * carries no new information, so it's ignored deterministically rather
 * than reapplied) — the same "duplicate timestamp behavior deterministic"
 * requirement this stage's own §10 asks for. True exact-duplicate
 * deliveries (identical `providerEventId`) never even reach this function
 * — the webhook route's own idempotency check (a DB unique-constraint
 * insert, see the route) short-circuits those before any mapping happens;
 * this guard is for two *different* events arriving out of order.
 */
export function applyBillingEventToSubscription(input: {
  event: NormalizedBillingEvent;
  existingSubscription: SubscriptionRowForMapping | null;
  now: Date;
}): ApplyBillingEventOutcome {
  const { event, existingSubscription } = input;

  if (event.type === "EVENT_IGNORED") {
    return { outcome: "IGNORE_EVENT_TYPE" };
  }

  if (!event.organizationId) {
    return { outcome: "REJECT_MISSING_ORGANIZATION" };
  }

  // A real subscription event carries no usable information without
  // these three — never crashes, never partially applies.
  if (!event.status || !event.providerSubscriptionId || !event.providerCustomerId) {
    return { outcome: "REJECT_MALFORMED" };
  }

  if (
    existingSubscription?.providerUpdatedAt &&
    event.providerUpdatedAt.getTime() <= existingSubscription.providerUpdatedAt.getTime()
  ) {
    return { outcome: "IGNORE_OLDER_EVENT" };
  }

  // Stored verbatim even if unrecognized — entitlements.ts's own
  // buildOrganizationEntitlements already falls any unrecognized planKey
  // back to LEGACY-safe behavior, so this mapper never needs to validate
  // it against the catalog itself (this stage's own "unknown plan" case).
  const planKey = event.planKey ?? existingSubscription?.planKey ?? "LEGACY";
  const planChanged = existingSubscription !== null && existingSubscription.planKey !== planKey;

  const enteringPastDue = event.status === "PAST_DUE";
  const alreadyInPastDueWithGrace = existingSubscription?.status === "PAST_DUE" && existingSubscription.gracePeriodEndsAt;
  const gracePeriodEndsAt = enteringPastDue
    ? alreadyInPastDueWithGrace
      ? existingSubscription!.gracePeriodEndsAt
      : new Date(input.now.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000)
    : null;

  const canceledAt =
    event.status === "CANCELED"
      ? existingSubscription?.status === "CANCELED"
        ? existingSubscription.canceledAt
        : input.now
      : null;

  return {
    outcome: "APPLY",
    planChanged,
    data: {
      planKey,
      status: event.status,
      providerCustomerId: event.providerCustomerId,
      providerSubscriptionId: event.providerSubscriptionId,
      currentPeriodStart: event.currentPeriodStart,
      currentPeriodEnd: event.currentPeriodEnd,
      cancelAtPeriodEnd: event.cancelAtPeriodEnd ?? false,
      canceledAt,
      gracePeriodEndsAt,
      providerUpdatedAt: event.providerUpdatedAt,
    },
  };
}
