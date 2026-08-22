import { describe, expect, it } from "vitest";
import { countActiveAndExpiredTrials, startOfUtcDay } from "@/lib/platform-admin/queries/platform-dashboard";
import type { SubscriptionStateInput } from "@/lib/billing/access-mode";

function trialing(trialEndsAt: Date): SubscriptionStateInput {
  return { status: "TRIALING", trialEndsAt, currentPeriodEnd: null, gracePeriodEndsAt: null };
}

describe("countActiveAndExpiredTrials", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");

  it("returns zero/zero for no trialing subscriptions", () => {
    expect(countActiveAndExpiredTrials([], now)).toEqual({ active: 0, expired: 0 });
  });

  it("counts a subscription whose trial ends in the future as active", () => {
    const subs = [trialing(new Date("2026-06-20T00:00:00.000Z"))];
    expect(countActiveAndExpiredTrials(subs, now)).toEqual({ active: 1, expired: 0 });
  });

  it("counts a subscription whose trial ended in the past as expired", () => {
    const subs = [trialing(new Date("2026-06-01T00:00:00.000Z"))];
    expect(countActiveAndExpiredTrials(subs, now)).toEqual({ active: 0, expired: 1 });
  });

  it("boundary: trialEndsAt exactly equal to now counts as active — inclusive, matching computeAccessMode exactly", () => {
    const subs = [trialing(now)];
    expect(countActiveAndExpiredTrials(subs, now)).toEqual({ active: 1, expired: 0 });
  });

  it("boundary: one millisecond past trialEndsAt counts as expired", () => {
    const subs = [trialing(new Date(now.getTime() - 1))];
    expect(countActiveAndExpiredTrials(subs, now)).toEqual({ active: 0, expired: 1 });
  });

  it("classifies a mixed set correctly", () => {
    const subs = [
      trialing(new Date("2026-07-01T00:00:00.000Z")), // active
      trialing(new Date("2026-06-01T00:00:00.000Z")), // expired
      trialing(new Date("2026-06-16T00:00:00.000Z")), // active
      trialing(new Date("2026-01-01T00:00:00.000Z")), // expired
    ];
    expect(countActiveAndExpiredTrials(subs, now)).toEqual({ active: 2, expired: 2 });
  });
});

describe("startOfUtcDay", () => {
  it("returns UTC midnight for a time later the same UTC day", () => {
    const now = new Date("2026-06-15T23:59:59.999Z");
    expect(startOfUtcDay(now).toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it("returns UTC midnight for a time just after UTC midnight", () => {
    const now = new Date("2026-06-15T00:00:00.001Z");
    expect(startOfUtcDay(now).toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it("a time one millisecond before UTC midnight belongs to the previous day", () => {
    const now = new Date("2026-06-14T23:59:59.999Z");
    expect(startOfUtcDay(now).toISOString()).toBe("2026-06-14T00:00:00.000Z");
  });
});
