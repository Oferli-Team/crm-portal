import { describe, expect, it } from "vitest";
import { buildOrganizationEntitlements, type SubscriptionStateForEntitlements } from "@/lib/billing/entitlements";
import { PLAN_CATALOG } from "@/lib/billing/plans";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function activeSubscription(overrides: Partial<SubscriptionStateForEntitlements> = {}): SubscriptionStateForEntitlements {
  return {
    planKey: "STARTER",
    status: "ACTIVE",
    trialEndsAt: new Date(NOW.getTime() - DAY_MS),
    currentPeriodEnd: null,
    gracePeriodEndsAt: null,
    ...overrides,
  };
}

function usage(overrides: Partial<{ members: number; clients: number; projects: number; storageBytes: number; pendingInvitations: number }> = {}) {
  return { members: 0, clients: 0, projects: 0, storageBytes: 0, pendingInvitations: 0, ...overrides };
}

describe("buildOrganizationEntitlements — member limit", () => {
  it("under the limit: canInviteMember is true", () => {
    const result = buildOrganizationEntitlements({
      subscription: activeSubscription({ planKey: "STARTER" }), // maxMembers: 1
      usage: usage({ members: 0 }),
      now: NOW,
    });
    expect(result.canInviteMember).toBe(true);
    expect(result.blockedReasons).not.toContain("MEMBER_LIMIT_REACHED");
  });

  it("at the limit: canInviteMember is false", () => {
    const result = buildOrganizationEntitlements({
      subscription: activeSubscription({ planKey: "STARTER" }), // maxMembers: 1
      usage: usage({ members: 1 }),
      now: NOW,
    });
    expect(result.canInviteMember).toBe(false);
    expect(result.blockedReasons).toContain("MEMBER_LIMIT_REACHED");
  });

  it("over the limit: canInviteMember stays false (never negative logic, no crash)", () => {
    const result = buildOrganizationEntitlements({
      subscription: activeSubscription({ planKey: "STARTER" }),
      usage: usage({ members: 5 }),
      now: NOW,
    });
    expect(result.canInviteMember).toBe(false);
  });

  it("pending invitations count toward the member limit", () => {
    const result = buildOrganizationEntitlements({
      subscription: activeSubscription({ planKey: "PRO" }), // maxMembers: 5
      usage: usage({ members: 4, pendingInvitations: 1 }),
      now: NOW,
    });
    expect(result.canInviteMember).toBe(false);
    expect(result.blockedReasons).toContain("MEMBER_LIMIT_REACHED");
  });

  it("currentMembers reports only real Membership rows, never inflated by pending invitations", () => {
    const result = buildOrganizationEntitlements({
      subscription: activeSubscription({ planKey: "PRO" }),
      usage: usage({ members: 2, pendingInvitations: 3 }),
      now: NOW,
    });
    expect(result.currentMembers).toBe(2);
  });
});

describe("buildOrganizationEntitlements — client limit", () => {
  it("under/at/over", () => {
    const maxClients = PLAN_CATALOG.STARTER.limits.maxClients!;
    const under = buildOrganizationEntitlements({ subscription: activeSubscription(), usage: usage({ clients: maxClients - 1 }), now: NOW });
    const at = buildOrganizationEntitlements({ subscription: activeSubscription(), usage: usage({ clients: maxClients }), now: NOW });
    const over = buildOrganizationEntitlements({ subscription: activeSubscription(), usage: usage({ clients: maxClients + 5 }), now: NOW });
    expect(under.canCreateClient).toBe(true);
    expect(at.canCreateClient).toBe(false);
    expect(over.canCreateClient).toBe(false);
  });

  it("null (unlimited) maxClients never blocks, at any count", () => {
    const result = buildOrganizationEntitlements({
      subscription: activeSubscription({ planKey: "PRO" }),
      usage: usage({ clients: 100_000 }),
      now: NOW,
    });
    expect(result.canCreateClient).toBe(true);
    expect(result.maxClients).toBeNull();
  });
});

describe("buildOrganizationEntitlements — project limit", () => {
  it("under/at/over", () => {
    const maxProjects = PLAN_CATALOG.STARTER.limits.maxProjects!;
    const under = buildOrganizationEntitlements({ subscription: activeSubscription(), usage: usage({ projects: maxProjects - 1 }), now: NOW });
    const at = buildOrganizationEntitlements({ subscription: activeSubscription(), usage: usage({ projects: maxProjects }), now: NOW });
    expect(under.canCreateProject).toBe(true);
    expect(at.canCreateProject).toBe(false);
  });
});

describe("buildOrganizationEntitlements — storage limit", () => {
  it("under/at the byte ceiling", () => {
    const max = PLAN_CATALOG.STARTER.limits.maxStorageBytes;
    const under = buildOrganizationEntitlements({ subscription: activeSubscription(), usage: usage({ storageBytes: max - 1 }), now: NOW });
    const at = buildOrganizationEntitlements({ subscription: activeSubscription(), usage: usage({ storageBytes: max }), now: NOW });
    expect(under.canUploadBytes(0)).toBe(true);
    expect(at.canUploadBytes(1)).toBe(false);
  });

  it("canUploadBytes(size) — an upload that would cross the limit is rejected even if current usage is under it", () => {
    const max = PLAN_CATALOG.STARTER.limits.maxStorageBytes;
    const result = buildOrganizationEntitlements({ subscription: activeSubscription(), usage: usage({ storageBytes: max - 100 }), now: NOW });
    expect(result.canUploadBytes(50)).toBe(true); // fits
    expect(result.canUploadBytes(150)).toBe(false); // would cross
  });

  it("canUploadBytes(size) — an upload landing exactly on the ceiling is allowed (inclusive)", () => {
    const max = PLAN_CATALOG.STARTER.limits.maxStorageBytes;
    const result = buildOrganizationEntitlements({ subscription: activeSubscription(), usage: usage({ storageBytes: max - 100 }), now: NOW });
    expect(result.canUploadBytes(100)).toBe(true);
  });
});

describe("buildOrganizationEntitlements — read-only mode", () => {
  it("READ_ONLY access mode blocks every can* boolean, regardless of how much headroom the plan's own limits would otherwise allow", () => {
    const result = buildOrganizationEntitlements({
      subscription: activeSubscription({ status: "UNPAID", planKey: "PRO" }), // PRO has generous/unlimited limits
      usage: usage({ members: 0, clients: 0, projects: 0, storageBytes: 0 }),
      now: NOW,
    });
    expect(result.accessMode).toBe("READ_ONLY");
    expect(result.canInviteMember).toBe(false);
    expect(result.canCreateClient).toBe(false);
    expect(result.canCreateProject).toBe(false);
    expect(result.canUploadBytes(1)).toBe(false);
    expect(result.blockedReasons).toContain("READ_ONLY_ACCESS");
  });

  it("read-only mode never appears as a false 'over count limit' reason when the real cause is access mode", () => {
    const result = buildOrganizationEntitlements({
      subscription: activeSubscription({ status: "UNPAID", planKey: "PRO" }),
      usage: usage({ members: 0 }), // well under any real limit
      now: NOW,
    });
    expect(result.blockedReasons).toContain("READ_ONLY_ACCESS");
    expect(result.blockedReasons).not.toContain("MEMBER_LIMIT_REACHED");
  });
});

describe("buildOrganizationEntitlements — no destructive restriction", () => {
  it("the entitlements contract has no field or method that could hide or delete existing data — only forward-looking booleans/counts", () => {
    const result = buildOrganizationEntitlements({
      subscription: activeSubscription({ status: "CANCELED", currentPeriodEnd: new Date(NOW.getTime() - DAY_MS) }),
      usage: usage({ members: 10, clients: 10, projects: 10, storageBytes: 10 }), // way over every limit
      now: NOW,
    });
    // Existing usage counts are reported as-is, never clamped/hidden/zeroed.
    expect(result.currentMembers).toBe(10);
    expect(result.currentClients).toBe(10);
    expect(result.currentProjects).toBe(10);
    expect(result.currentStorageBytes).toBe(10);
    // No field on this contract represents "delete" or "hide" — the shape
    // itself only ever describes forward creation ability.
    expect(Object.keys(result)).not.toContain("shouldDelete");
    expect(Object.keys(result)).not.toContain("hidden");
  });
});

describe("buildOrganizationEntitlements — legacy fallback (no Subscription row)", () => {
  it("null subscription resolves to LEGACY plan and FULL_ACCESS", () => {
    const result = buildOrganizationEntitlements({
      subscription: null,
      usage: usage({ members: 500 }),
      now: NOW,
    });
    expect(result.planKey).toBe("LEGACY");
    expect(result.subscriptionStatus).toBe("LEGACY");
    expect(result.accessMode).toBe("FULL_ACCESS");
    expect(result.canInviteMember).toBe(true);
    expect(result.trialEndsAt).toBeNull();
    expect(result.gracePeriodEndsAt).toBeNull();
  });

  it("an unrecognized planKey string on an existing row also falls back to LEGACY (defensive, never a crash)", () => {
    const result = buildOrganizationEntitlements({
      subscription: activeSubscription({ planKey: "SOME_RETIRED_PLAN" }),
      usage: usage(),
      now: NOW,
    });
    expect(result.planKey).toBe("LEGACY");
  });

  it("Stage 5 audit fix: a real row resolving to the LEGACY plan also reports subscriptionStatus LEGACY, not its own raw status", () => {
    // Regression guard for the exact shape prisma/backfill-subscriptions.ts
    // writes: a real Subscription row, status ACTIVE, planKey LEGACY.
    // Before this fix, subscriptionStatus only ever became "LEGACY" when
    // no row existed at all — a backfilled/corrupted-planKey row with a
    // real `status: "ACTIVE"` rendered plan "Legacy (pre-billing)" next to
    // a green "Active" badge and "Your subscription is active" message,
    // which is false for an organization that has never had a real
    // subscription.
    const backfilled = buildOrganizationEntitlements({
      subscription: activeSubscription({ planKey: "LEGACY", status: "ACTIVE" }),
      usage: usage(),
      now: NOW,
    });
    expect(backfilled.planKey).toBe("LEGACY");
    expect(backfilled.subscriptionStatus).toBe("LEGACY");

    // Same fix, via the "unrecognized planKey" path rather than the
    // literal LEGACY key — both resolve `planKey` to LEGACY, so both must
    // resolve `subscriptionStatus` to LEGACY too, for the same reason.
    const unrecognized = buildOrganizationEntitlements({
      subscription: activeSubscription({ planKey: "SOME_RETIRED_PLAN", status: "ACTIVE" }),
      usage: usage(),
      now: NOW,
    });
    expect(unrecognized.subscriptionStatus).toBe("LEGACY");
  });

  it("a real, recognized non-LEGACY plan is unaffected by this fix — its own real status still reports as-is", () => {
    const result = buildOrganizationEntitlements({
      subscription: activeSubscription({ planKey: "PRO", status: "PAST_DUE" }),
      usage: usage(),
      now: NOW,
    });
    expect(result.planKey).toBe("PRO");
    expect(result.subscriptionStatus).toBe("PAST_DUE");
  });
});

describe("buildOrganizationEntitlements — reason codes", () => {
  it("blockedReasons is empty when nothing is blocked", () => {
    const result = buildOrganizationEntitlements({ subscription: activeSubscription({ planKey: "PRO" }), usage: usage(), now: NOW });
    expect(result.blockedReasons).toEqual([]);
  });

  it("blockedReasons can contain multiple simultaneous reasons", () => {
    const result = buildOrganizationEntitlements({
      subscription: activeSubscription({ planKey: "STARTER" }),
      usage: usage({ members: 1, clients: 10, projects: 20, storageBytes: PLAN_CATALOG.STARTER.limits.maxStorageBytes }),
      now: NOW,
    });
    expect(result.blockedReasons).toEqual(
      expect.arrayContaining(["MEMBER_LIMIT_REACHED", "CLIENT_LIMIT_REACHED", "PROJECT_LIMIT_REACHED", "STORAGE_LIMIT_REACHED"]),
    );
  });

  it("never returns a provider id, price id, or any raw internal field", () => {
    const result = buildOrganizationEntitlements({ subscription: activeSubscription(), usage: usage(), now: NOW });
    const serialized = JSON.stringify(result, (_key, value) => (typeof value === "function" ? "[fn]" : value));
    expect(serialized).not.toMatch(/provider/i);
    expect(serialized).not.toMatch(/price/i);
    expect(serialized).not.toMatch(/customerId/i);
    expect(serialized).not.toMatch(/subscriptionId/i);
  });
});
