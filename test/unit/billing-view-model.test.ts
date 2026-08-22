import { describe, expect, it, vi } from "vitest";

// src/lib/billing/view-model.ts transitively imports src/lib/billing/
// provider-availability.ts, which imports the real "server-only" marker
// package — see test/unit/cron-auth.test.ts's own header comment. vi.mock
// calls are hoisted above these imports automatically, so a normal static
// import below still resolves against the mocked module.
vi.mock("server-only", () => ({}));

import { buildBillingPageViewModel } from "@/lib/billing/view-model";
import type { OrganizationEntitlements } from "@/lib/billing/entitlements";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-15T12:00:00.000Z");

const PROVIDER_UNCONFIGURED = {
  configured: false,
  provider: "PADDLE" as const,
  checkoutAvailable: false,
  portalAvailable: false,
};

function entitlements(overrides: Partial<OrganizationEntitlements> & { planKey: OrganizationEntitlements["planKey"] }): OrganizationEntitlements {
  return {
    subscriptionStatus: "ACTIVE",
    accessMode: "FULL_ACCESS",
    maxMembers: 5,
    maxClients: null,
    maxProjects: null,
    maxStorageBytes: 10 * 1024 * 1024 * 1024,
    currentMembers: 1,
    currentClients: 0,
    currentProjects: 0,
    currentStorageBytes: 0,
    canInviteMember: true,
    canCreateClient: true,
    canCreateProject: true,
    canUploadBytes: () => true,
    trialEndsAt: null,
    gracePeriodEndsAt: null,
    blockedReasons: [],
    ...overrides,
  };
}

function build(
  overrides: Partial<Parameters<typeof buildBillingPageViewModel>[0]> & {
    entitlements: OrganizationEntitlements;
  },
) {
  return buildBillingPageViewModel({
    pendingInvitations: 0,
    role: "OWNER",
    now: NOW,
    providerAvailability: PROVIDER_UNCONFIGURED,
    ...overrides,
  });
}

describe("TRIALING", () => {
  it("more than 3 days left: info tone, not approaching", () => {
    const vm = build({
      entitlements: entitlements({
        planKey: "TRIAL",
        subscriptionStatus: "TRIALING",
        trialEndsAt: new Date(NOW.getTime() + 5 * DAY_MS),
      }),
    });
    expect(vm.trialDaysRemaining).toBe(5);
    expect(vm.trialApproachingEnd).toBe(false);
    expect(vm.trialExpired).toBe(false);
    expect(vm.statusNotice.tone).toBe("info");
    expect(vm.statusNotice.message).toContain("Trial ends in 5 days");
  });

  it("exactly 3 days left: approaching, warning tone", () => {
    const vm = build({
      entitlements: entitlements({
        planKey: "TRIAL",
        subscriptionStatus: "TRIALING",
        trialEndsAt: new Date(NOW.getTime() + 3 * DAY_MS),
      }),
    });
    expect(vm.trialDaysRemaining).toBe(3);
    expect(vm.trialApproachingEnd).toBe(true);
    expect(vm.trialExpired).toBe(false);
    expect(vm.statusNotice.tone).toBe("warning");
  });

  it("boundary: now exactly equal to trialEndsAt is 0 days remaining, approaching, not expired", () => {
    const vm = build({
      entitlements: entitlements({ planKey: "TRIAL", subscriptionStatus: "TRIALING", trialEndsAt: NOW }),
    });
    expect(vm.trialDaysRemaining).toBe(0);
    expect(vm.trialApproachingEnd).toBe(true);
    expect(vm.trialExpired).toBe(false);
  });

  it("boundary: one millisecond past trialEndsAt is expired", () => {
    const vm = build({
      entitlements: entitlements({
        planKey: "TRIAL",
        subscriptionStatus: "TRIALING",
        accessMode: "READ_ONLY",
        trialEndsAt: new Date(NOW.getTime() - 1),
      }),
    });
    expect(vm.trialExpired).toBe(true);
    expect(vm.trialApproachingEnd).toBe(false);
    expect(vm.statusNotice.tone).toBe("danger");
    expect(vm.statusNotice.message).toContain("trial has ended");
  });
});

describe("ACTIVE", () => {
  it("success tone, no trial fields set", () => {
    const vm = build({ entitlements: entitlements({ planKey: "PRO", subscriptionStatus: "ACTIVE" }) });
    expect(vm.statusNotice.tone).toBe("success");
    expect(vm.statusNotice.message).toBe("Your subscription is active.");
    expect(vm.trialEndsAt).toBeNull();
    expect(vm.trialDaysRemaining).toBeNull();
  });
});

describe("PAST_DUE", () => {
  it("within grace period: warning tone", () => {
    const vm = build({
      entitlements: entitlements({
        planKey: "PRO",
        subscriptionStatus: "PAST_DUE",
        accessMode: "FULL_ACCESS",
        gracePeriodEndsAt: new Date(NOW.getTime() + DAY_MS),
      }),
    });
    expect(vm.statusNotice.tone).toBe("warning");
    expect(vm.statusNotice.message).toContain("grace period");
  });

  it("past grace period: danger tone, read-only copy", () => {
    const vm = build({
      entitlements: entitlements({
        planKey: "PRO",
        subscriptionStatus: "PAST_DUE",
        accessMode: "READ_ONLY",
        gracePeriodEndsAt: new Date(NOW.getTime() - DAY_MS),
      }),
    });
    expect(vm.statusNotice.tone).toBe("danger");
    expect(vm.statusNotice.message).toContain("read-only");
  });
});

describe("CANCELED", () => {
  it("still within the paid period: warning tone, access continues", () => {
    const vm = build({
      entitlements: entitlements({ planKey: "PRO", subscriptionStatus: "CANCELED", accessMode: "FULL_ACCESS" }),
      currentPeriodEnd: new Date(NOW.getTime() + DAY_MS),
      cancelAtPeriodEnd: true,
    });
    expect(vm.statusNotice.tone).toBe("warning");
    expect(vm.cancelAtPeriodEnd).toBe(true);
    expect(vm.currentPeriodEnd).not.toBeNull();
  });

  it("after the paid period ends: danger tone, read-only copy", () => {
    const vm = build({
      entitlements: entitlements({ planKey: "PRO", subscriptionStatus: "CANCELED", accessMode: "READ_ONLY" }),
      currentPeriodEnd: new Date(NOW.getTime() - DAY_MS),
      cancelAtPeriodEnd: true,
    });
    expect(vm.statusNotice.tone).toBe("danger");
    expect(vm.statusNotice.message).toContain("read-only");
  });
});

describe("INCOMPLETE", () => {
  it("warning tone, limited-writes copy", () => {
    const vm = build({
      entitlements: entitlements({ planKey: "PRO", subscriptionStatus: "INCOMPLETE", accessMode: "LIMITED_WRITES" }),
    });
    expect(vm.statusNotice.tone).toBe("warning");
    expect(vm.accessModeBanner?.tone).toBe("warning");
  });
});

describe("UNPAID", () => {
  it("danger tone, read-only copy", () => {
    const vm = build({
      entitlements: entitlements({ planKey: "PRO", subscriptionStatus: "UNPAID", accessMode: "READ_ONLY" }),
    });
    expect(vm.statusNotice.tone).toBe("danger");
    expect(vm.statusNotice.message).toContain("read-only");
  });
});

describe("LEGACY (no Subscription row)", () => {
  it("is never treated as an error/empty state — neutral tone, full access, no alarming banner", () => {
    const vm = build({
      entitlements: entitlements({
        planKey: "LEGACY",
        subscriptionStatus: "LEGACY",
        accessMode: "FULL_ACCESS",
        maxMembers: 1000,
      }),
    });
    expect(vm.isLegacy).toBe(true);
    expect(vm.statusNotice.tone).toBe("neutral");
    expect(vm.accessModeBanner).toBeNull();
    expect(vm.currentPlanName).toBe("Legacy (pre-billing)");
  });
});

describe("access-mode banner", () => {
  it("FULL_ACCESS never shows an alarming banner", () => {
    const vm = build({ entitlements: entitlements({ planKey: "PRO", accessMode: "FULL_ACCESS" }) });
    expect(vm.accessModeBanner).toBeNull();
  });

  it("READ_ONLY shows a danger banner that never hides the page", () => {
    const vm = build({ entitlements: entitlements({ planKey: "PRO", accessMode: "READ_ONLY" }) });
    expect(vm.accessModeBanner?.tone).toBe("danger");
    expect(vm.accessModeBanner?.message).toContain("read-only");
  });
});

describe("unknown plan key", () => {
  it("falls back to a generic 'Custom plan' label instead of crashing", () => {
    const vm = build({
      entitlements: entitlements({ planKey: "SOMETHING_UNRECOGNIZED" as OrganizationEntitlements["planKey"] }),
    });
    expect(vm.currentPlanName).toBe("Custom plan");
  });
});

describe("provider ids never leak into the view-model", () => {
  it("has no providerCustomerId/providerSubscriptionId/providerEventId key anywhere in the serialized output", () => {
    const vm = build({ entitlements: entitlements({ planKey: "PRO" }) });
    const serialized = JSON.stringify(vm);
    expect(serialized).not.toMatch(/providerCustomerId|providerSubscriptionId|providerEventId/);
  });
});

describe("usage rows: pending invitations counted into Members", () => {
  it("adds pendingInvitations on top of currentMembers, matching the entitlement engine's own limit check", () => {
    const vm = build({
      entitlements: entitlements({ planKey: "STARTER", maxMembers: 5, currentMembers: 2 }),
      pendingInvitations: 2,
    });
    const membersRow = vm.usageRows.find((r) => r.key === "members")!;
    expect(membersRow.current).toBe(4);
    expect(membersRow.limit).toBe(5);
  });
});

describe("plan cards", () => {
  it("marks the current plan and disables its own CTA", () => {
    const vm = build({ entitlements: entitlements({ planKey: "STARTER" }) });
    const starter = vm.availablePlans.find((p) => p.planKey === "STARTER")!;
    expect(starter.isCurrentPlan).toBe(true);
    expect(starter.ctaLabel).toBe("Current plan");
    expect(starter.ctaDisabled).toBe(true);
  });

  it("offers Upgrade for a higher plan than the current one", () => {
    const vm = build({ entitlements: entitlements({ planKey: "STARTER" }) });
    const pro = vm.availablePlans.find((p) => p.planKey === "PRO")!;
    expect(pro.ctaLabel).toBe("Upgrade");
    expect(pro.ctaDisabled).toBe(false);
  });

  it("offers Downgrade for a lower plan than the current one", () => {
    const vm = build({ entitlements: entitlements({ planKey: "PRO" }) });
    const starter = vm.availablePlans.find((p) => p.planKey === "STARTER")!;
    expect(starter.ctaLabel).toBe("Downgrade");
    expect(starter.ctaDisabled).toBe(false);
  });

  it("never includes TRIAL or LEGACY as a purchasable card", () => {
    const vm = build({ entitlements: entitlements({ planKey: "TRIAL" }) });
    const planKeys = vm.availablePlans.map((p) => p.planKey);
    expect(planKeys).not.toContain("TRIAL");
    expect(planKeys).not.toContain("LEGACY");
    expect(planKeys.sort()).toEqual(["PRO", "STARTER"]);
  });

  it("disables every non-current plan's CTA for a non-owner, with an explanatory reason surfaced via permissions", () => {
    const vm = build({ entitlements: entitlements({ planKey: "STARTER" }), role: "MEMBER" });
    expect(vm.permissions.canManagePlan).toBe(false);
    const pro = vm.availablePlans.find((p) => p.planKey === "PRO")!;
    expect(pro.ctaDisabled).toBe(true);
  });
});

describe("permissions by role", () => {
  it("OWNER can manage plan and subscription", () => {
    const vm = build({ entitlements: entitlements({ planKey: "PRO" }), role: "OWNER" });
    expect(vm.permissions.canManagePlan).toBe(true);
    expect(vm.permissions.canManageSubscription).toBe(true);
  });

  it("ADMIN cannot manage plan or subscription", () => {
    const vm = build({ entitlements: entitlements({ planKey: "PRO" }), role: "ADMIN" });
    expect(vm.permissions.canManagePlan).toBe(false);
    expect(vm.permissions.canManageSubscription).toBe(false);
  });

  it("MEMBER cannot manage plan or subscription", () => {
    const vm = build({ entitlements: entitlements({ planKey: "PRO" }), role: "MEMBER" });
    expect(vm.permissions.canManagePlan).toBe(false);
    expect(vm.permissions.canManageSubscription).toBe(false);
  });
});

describe("providerConfigured", () => {
  it("is always false in Stage 3", () => {
    const vm = build({ entitlements: entitlements({ planKey: "PRO" }) });
    expect(vm.providerConfigured).toBe(false);
  });
});
