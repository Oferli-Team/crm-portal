import { describe, expect, it } from "vitest";
import { applyBillingEventToSubscription, GRACE_PERIOD_DAYS, type SubscriptionRowForMapping } from "@/lib/billing/event-mapper";
import type { NormalizedBillingEvent } from "@/lib/billing/provider/types";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-15T12:00:00.000Z");
const ORG_ID = "11111111-1111-1111-1111-111111111111";

function event(overrides: Partial<NormalizedBillingEvent> = {}): NormalizedBillingEvent {
  return {
    type: "SUBSCRIPTION_UPDATED",
    providerEventId: "evt_1",
    providerCreatedAt: NOW,
    providerCustomerId: "cus_1",
    providerSubscriptionId: "sub_1",
    organizationId: ORG_ID,
    planKey: "STARTER",
    status: "ACTIVE",
    currentPeriodStart: NOW,
    currentPeriodEnd: new Date(NOW.getTime() + 30 * DAY_MS),
    cancelAtPeriodEnd: false,
    trialEnd: null,
    providerUpdatedAt: NOW,
    ...overrides,
  };
}

function row(overrides: Partial<SubscriptionRowForMapping> = {}): SubscriptionRowForMapping {
  return {
    planKey: "STARTER",
    status: "ACTIVE",
    currentPeriodStart: new Date(NOW.getTime() - 5 * DAY_MS),
    currentPeriodEnd: new Date(NOW.getTime() + 25 * DAY_MS),
    cancelAtPeriodEnd: false,
    canceledAt: null,
    gracePeriodEndsAt: null,
    providerUpdatedAt: new Date(NOW.getTime() - DAY_MS),
    ...overrides,
  };
}

describe("EVENT_IGNORED", () => {
  it("is a pass-through ignore, never touches Subscription", () => {
    const outcome = applyBillingEventToSubscription({
      event: event({ type: "EVENT_IGNORED" }),
      existingSubscription: null,
      now: NOW,
    });
    expect(outcome).toEqual({ outcome: "IGNORE_EVENT_TYPE" });
  });
});

describe("missing organization", () => {
  it("rejects when the event carries no organizationId claim", () => {
    const outcome = applyBillingEventToSubscription({
      event: event({ organizationId: null }),
      existingSubscription: null,
      now: NOW,
    });
    expect(outcome).toEqual({ outcome: "REJECT_MISSING_ORGANIZATION" });
  });
});

describe("malformed event", () => {
  it("rejects when status is missing", () => {
    const outcome = applyBillingEventToSubscription({
      event: event({ status: null }),
      existingSubscription: null,
      now: NOW,
    });
    expect(outcome.outcome).toBe("REJECT_MALFORMED");
  });

  it("rejects when providerSubscriptionId is missing", () => {
    const outcome = applyBillingEventToSubscription({
      event: event({ providerSubscriptionId: null }),
      existingSubscription: null,
      now: NOW,
    });
    expect(outcome.outcome).toBe("REJECT_MALFORMED");
  });

  it("rejects when providerCustomerId is missing", () => {
    const outcome = applyBillingEventToSubscription({
      event: event({ providerCustomerId: null }),
      existingSubscription: null,
      now: NOW,
    });
    expect(outcome.outcome).toBe("REJECT_MALFORMED");
  });
});

describe("older / out-of-order events", () => {
  it("ignores an event whose providerUpdatedAt is strictly older than the row's own", () => {
    const outcome = applyBillingEventToSubscription({
      event: event({ providerUpdatedAt: new Date(NOW.getTime() - 2 * DAY_MS) }),
      existingSubscription: row({ providerUpdatedAt: NOW }),
      now: NOW,
    });
    expect(outcome).toEqual({ outcome: "IGNORE_OLDER_EVENT" });
  });

  it("ignores an event whose providerUpdatedAt exactly equals the row's own (deterministic duplicate-timestamp handling)", () => {
    const outcome = applyBillingEventToSubscription({
      event: event({ providerUpdatedAt: NOW }),
      existingSubscription: row({ providerUpdatedAt: NOW }),
      now: NOW,
    });
    expect(outcome).toEqual({ outcome: "IGNORE_OLDER_EVENT" });
  });

  it("applies an event whose providerUpdatedAt is strictly newer", () => {
    const outcome = applyBillingEventToSubscription({
      event: event({ providerUpdatedAt: new Date(NOW.getTime() + 1) }),
      existingSubscription: row({ providerUpdatedAt: NOW }),
      now: NOW,
    });
    expect(outcome.outcome).toBe("APPLY");
  });

  it("applies against a subscription with no prior providerUpdatedAt at all (never webhook-touched before)", () => {
    const outcome = applyBillingEventToSubscription({
      event: event(),
      existingSubscription: row({ providerUpdatedAt: null }),
      now: NOW,
    });
    expect(outcome.outcome).toBe("APPLY");
  });
});

describe("status transitions — every SubscriptionStatus", () => {
  it("trialing", () => {
    const outcome = applyBillingEventToSubscription({
      event: event({ status: "TRIALING" }),
      existingSubscription: null,
      now: NOW,
    });
    expect(outcome.outcome).toBe("APPLY");
    if (outcome.outcome === "APPLY") expect(outcome.data.status).toBe("TRIALING");
  });

  it("active", () => {
    const outcome = applyBillingEventToSubscription({ event: event({ status: "ACTIVE" }), existingSubscription: null, now: NOW });
    expect(outcome.outcome).toBe("APPLY");
    if (outcome.outcome === "APPLY") {
      expect(outcome.data.status).toBe("ACTIVE");
      expect(outcome.data.gracePeriodEndsAt).toBeNull();
      expect(outcome.data.canceledAt).toBeNull();
    }
  });

  it("past_due — sets a fresh 7-day grace period the first time it enters PAST_DUE", () => {
    const outcome = applyBillingEventToSubscription({
      event: event({ status: "PAST_DUE" }),
      existingSubscription: row({ status: "ACTIVE" }),
      now: NOW,
    });
    expect(outcome.outcome).toBe("APPLY");
    if (outcome.outcome === "APPLY") {
      expect(outcome.data.status).toBe("PAST_DUE");
      expect(outcome.data.gracePeriodEndsAt).toEqual(new Date(NOW.getTime() + GRACE_PERIOD_DAYS * DAY_MS));
    }
  });

  it("past_due — preserves the existing grace period on a repeated PAST_DUE event, never resets the clock", () => {
    const existingGraceEnd = new Date(NOW.getTime() + 3 * DAY_MS);
    const outcome = applyBillingEventToSubscription({
      event: event({ status: "PAST_DUE", providerUpdatedAt: new Date(NOW.getTime() + 1) }),
      existingSubscription: row({ status: "PAST_DUE", gracePeriodEndsAt: existingGraceEnd, providerUpdatedAt: NOW }),
      now: NOW,
    });
    expect(outcome.outcome).toBe("APPLY");
    if (outcome.outcome === "APPLY") {
      expect(outcome.data.gracePeriodEndsAt).toEqual(existingGraceEnd);
    }
  });

  it("recovering from past_due back to active clears the grace period", () => {
    const outcome = applyBillingEventToSubscription({
      event: event({ status: "ACTIVE" }),
      existingSubscription: row({ status: "PAST_DUE", gracePeriodEndsAt: new Date(NOW.getTime() + 3 * DAY_MS) }),
      now: NOW,
    });
    expect(outcome.outcome).toBe("APPLY");
    if (outcome.outcome === "APPLY") expect(outcome.data.gracePeriodEndsAt).toBeNull();
  });

  it("canceled — sets canceledAt to now the first time it enters CANCELED", () => {
    const outcome = applyBillingEventToSubscription({
      event: event({ status: "CANCELED", cancelAtPeriodEnd: true }),
      existingSubscription: row({ status: "ACTIVE" }),
      now: NOW,
    });
    expect(outcome.outcome).toBe("APPLY");
    if (outcome.outcome === "APPLY") expect(outcome.data.canceledAt).toEqual(NOW);
  });

  it("canceled — preserves the original canceledAt on a repeated CANCELED event", () => {
    const originalCanceledAt = new Date(NOW.getTime() - 2 * DAY_MS);
    const outcome = applyBillingEventToSubscription({
      event: event({ status: "CANCELED", cancelAtPeriodEnd: true, providerUpdatedAt: new Date(NOW.getTime() + 1) }),
      existingSubscription: row({ status: "CANCELED", canceledAt: originalCanceledAt, providerUpdatedAt: NOW }),
      now: NOW,
    });
    expect(outcome.outcome).toBe("APPLY");
    if (outcome.outcome === "APPLY") expect(outcome.data.canceledAt).toEqual(originalCanceledAt);
  });

  it("unpaid", () => {
    const outcome = applyBillingEventToSubscription({ event: event({ status: "UNPAID" }), existingSubscription: null, now: NOW });
    expect(outcome.outcome).toBe("APPLY");
    if (outcome.outcome === "APPLY") expect(outcome.data.status).toBe("UNPAID");
  });

  it("incomplete", () => {
    const outcome = applyBillingEventToSubscription({ event: event({ status: "INCOMPLETE" }), existingSubscription: null, now: NOW });
    expect(outcome.outcome).toBe("APPLY");
    if (outcome.outcome === "APPLY") expect(outcome.data.status).toBe("INCOMPLETE");
  });
});

describe("plan changes", () => {
  it("planChanged is true when the incoming planKey differs from the existing row's", () => {
    const outcome = applyBillingEventToSubscription({
      event: event({ planKey: "PRO" }),
      existingSubscription: row({ planKey: "STARTER" }),
      now: NOW,
    });
    expect(outcome.outcome).toBe("APPLY");
    if (outcome.outcome === "APPLY") expect(outcome.planChanged).toBe(true);
  });

  it("planChanged is false when the plan is unchanged", () => {
    const outcome = applyBillingEventToSubscription({
      event: event({ planKey: "STARTER" }),
      existingSubscription: row({ planKey: "STARTER" }),
      now: NOW,
    });
    expect(outcome.outcome).toBe("APPLY");
    if (outcome.outcome === "APPLY") expect(outcome.planChanged).toBe(false);
  });

  it("planChanged is false for a brand-new subscription (no prior row to compare against)", () => {
    const outcome = applyBillingEventToSubscription({ event: event({ planKey: "STARTER" }), existingSubscription: null, now: NOW });
    expect(outcome.outcome).toBe("APPLY");
    if (outcome.outcome === "APPLY") expect(outcome.planChanged).toBe(false);
  });

  it("an unrecognized planKey is stored verbatim, never crashes (entitlements.ts's own LEGACY fallback protects the rest of the app)", () => {
    const outcome = applyBillingEventToSubscription({
      event: event({ planKey: "SOME_FUTURE_PLAN" }),
      existingSubscription: null,
      now: NOW,
    });
    expect(outcome.outcome).toBe("APPLY");
    if (outcome.outcome === "APPLY") expect(outcome.data.planKey).toBe("SOME_FUTURE_PLAN");
  });
});

describe("current period / cancelAtPeriodEnd pass-through", () => {
  it("copies currentPeriodStart/End and cancelAtPeriodEnd verbatim from the event", () => {
    const start = new Date(NOW.getTime());
    const end = new Date(NOW.getTime() + 30 * DAY_MS);
    const outcome = applyBillingEventToSubscription({
      event: event({ currentPeriodStart: start, currentPeriodEnd: end, cancelAtPeriodEnd: true }),
      existingSubscription: null,
      now: NOW,
    });
    expect(outcome.outcome).toBe("APPLY");
    if (outcome.outcome === "APPLY") {
      expect(outcome.data.currentPeriodStart).toEqual(start);
      expect(outcome.data.currentPeriodEnd).toEqual(end);
      expect(outcome.data.cancelAtPeriodEnd).toBe(true);
    }
  });

  it("defaults cancelAtPeriodEnd to false when the event doesn't specify it", () => {
    const outcome = applyBillingEventToSubscription({
      event: event({ cancelAtPeriodEnd: null }),
      existingSubscription: null,
      now: NOW,
    });
    expect(outcome.outcome).toBe("APPLY");
    if (outcome.outcome === "APPLY") expect(outcome.data.cancelAtPeriodEnd).toBe(false);
  });
});
