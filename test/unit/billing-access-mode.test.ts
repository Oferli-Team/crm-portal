import { describe, expect, it } from "vitest";
import { computeAccessMode, LEGACY_ACCESS_MODE, type SubscriptionStateInput } from "@/lib/billing/access-mode";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-15T12:00:00.000Z");

function state(overrides: Partial<SubscriptionStateInput> & { status: SubscriptionStateInput["status"] }): SubscriptionStateInput {
  return {
    trialEndsAt: new Date(NOW.getTime() + DAY_MS),
    currentPeriodEnd: null,
    gracePeriodEndsAt: null,
    ...overrides,
  };
}

describe("TRIALING", () => {
  it("full access while trialEndsAt is in the future", () => {
    const result = computeAccessMode(state({ status: "TRIALING", trialEndsAt: new Date(NOW.getTime() + DAY_MS) }), NOW);
    expect(result).toBe("FULL_ACCESS");
  });

  it("read-only once trialEndsAt is in the past", () => {
    const result = computeAccessMode(state({ status: "TRIALING", trialEndsAt: new Date(NOW.getTime() - DAY_MS) }), NOW);
    expect(result).toBe("READ_ONLY");
  });

  it("boundary: now exactly equal to trialEndsAt is still FULL_ACCESS (inclusive)", () => {
    const result = computeAccessMode(state({ status: "TRIALING", trialEndsAt: NOW }), NOW);
    expect(result).toBe("FULL_ACCESS");
  });

  it("boundary: now one millisecond past trialEndsAt is READ_ONLY", () => {
    const result = computeAccessMode(state({ status: "TRIALING", trialEndsAt: new Date(NOW.getTime() - 1) }), NOW);
    expect(result).toBe("READ_ONLY");
  });
});

describe("ACTIVE", () => {
  it("is always full access, regardless of other fields", () => {
    expect(computeAccessMode(state({ status: "ACTIVE" }), NOW)).toBe("FULL_ACCESS");
    expect(
      computeAccessMode(
        state({ status: "ACTIVE", currentPeriodEnd: new Date(NOW.getTime() - DAY_MS), gracePeriodEndsAt: new Date(NOW.getTime() - DAY_MS) }),
        NOW,
      ),
    ).toBe("FULL_ACCESS");
  });
});

describe("PAST_DUE", () => {
  it("full access while inside the grace period", () => {
    const result = computeAccessMode(state({ status: "PAST_DUE", gracePeriodEndsAt: new Date(NOW.getTime() + DAY_MS) }), NOW);
    expect(result).toBe("FULL_ACCESS");
  });

  it("read-only once the grace period has passed", () => {
    const result = computeAccessMode(state({ status: "PAST_DUE", gracePeriodEndsAt: new Date(NOW.getTime() - DAY_MS) }), NOW);
    expect(result).toBe("READ_ONLY");
  });

  it("boundary: now exactly equal to gracePeriodEndsAt is still FULL_ACCESS (inclusive)", () => {
    const result = computeAccessMode(state({ status: "PAST_DUE", gracePeriodEndsAt: NOW }), NOW);
    expect(result).toBe("FULL_ACCESS");
  });

  it("read-only if gracePeriodEndsAt was never set at all", () => {
    const result = computeAccessMode(state({ status: "PAST_DUE", gracePeriodEndsAt: null }), NOW);
    expect(result).toBe("READ_ONLY");
  });
});

describe("CANCELED", () => {
  it("full access before currentPeriodEnd (cancelAtPeriodEnd semantics)", () => {
    const result = computeAccessMode(state({ status: "CANCELED", currentPeriodEnd: new Date(NOW.getTime() + DAY_MS) }), NOW);
    expect(result).toBe("FULL_ACCESS");
  });

  it("read-only after currentPeriodEnd", () => {
    const result = computeAccessMode(state({ status: "CANCELED", currentPeriodEnd: new Date(NOW.getTime() - DAY_MS) }), NOW);
    expect(result).toBe("READ_ONLY");
  });

  it("boundary: now exactly equal to currentPeriodEnd is still FULL_ACCESS (inclusive)", () => {
    const result = computeAccessMode(state({ status: "CANCELED", currentPeriodEnd: NOW }), NOW);
    expect(result).toBe("FULL_ACCESS");
  });

  it("read-only if currentPeriodEnd was never set at all", () => {
    const result = computeAccessMode(state({ status: "CANCELED", currentPeriodEnd: null }), NOW);
    expect(result).toBe("READ_ONLY");
  });
});

describe("UNPAID", () => {
  it("is always read-only, regardless of other fields (no grace period of its own)", () => {
    expect(computeAccessMode(state({ status: "UNPAID" }), NOW)).toBe("READ_ONLY");
    expect(
      computeAccessMode(state({ status: "UNPAID", gracePeriodEndsAt: new Date(NOW.getTime() + DAY_MS) }), NOW),
    ).toBe("READ_ONLY");
  });
});

describe("INCOMPLETE", () => {
  it("is always LIMITED_WRITES", () => {
    expect(computeAccessMode(state({ status: "INCOMPLETE" }), NOW)).toBe("LIMITED_WRITES");
  });
});

describe("Missing Subscription row (legacy organization)", () => {
  it("LEGACY_ACCESS_MODE is FULL_ACCESS", () => {
    expect(LEGACY_ACCESS_MODE).toBe("FULL_ACCESS");
  });
});

describe("exhaustiveness", () => {
  it("throws a clear error for an unrecognized status value (defensive — should be unreachable given the TypeScript enum)", () => {
    // @ts-expect-error — deliberately passing an invalid status to exercise the runtime guard.
    expect(() => computeAccessMode(state({ status: "SOMETHING_ELSE" }), NOW)).toThrow(/Unhandled SubscriptionStatus/);
  });
});
