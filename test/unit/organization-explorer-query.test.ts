import { describe, expect, it } from "vitest";
import {
  classifyOrganizationLifecycle,
  parseOrganizationListParams,
  buildOrganizationWhere,
  buildOrganizationOrderBy,
  ORGANIZATION_LIFECYCLE_STATUSES,
} from "@/lib/platform-admin/queries/organizations";
import type { SubscriptionStateInput } from "@/lib/billing/access-mode";

const NOW = new Date("2026-06-15T12:00:00.000Z");

function sub(overrides: Partial<SubscriptionStateInput> & { status: SubscriptionStateInput["status"] }): SubscriptionStateInput {
  return {
    trialEndsAt: new Date("2026-01-01T00:00:00.000Z"),
    currentPeriodEnd: null,
    gracePeriodEndsAt: null,
    ...overrides,
  };
}

describe("classifyOrganizationLifecycle", () => {
  it("no Subscription row at all -> LEGACY, never PAID", () => {
    expect(classifyOrganizationLifecycle(null, NOW)).toBe("LEGACY");
  });

  describe("TRIALING", () => {
    it("trial not yet ended -> TRIAL", () => {
      const s = sub({ status: "TRIALING", trialEndsAt: new Date(NOW.getTime() + 1000) });
      expect(classifyOrganizationLifecycle(s, NOW)).toBe("TRIAL");
    });

    it("boundary: trialEndsAt exactly now -> TRIAL (inclusive, matches computeAccessMode)", () => {
      const s = sub({ status: "TRIALING", trialEndsAt: NOW });
      expect(classifyOrganizationLifecycle(s, NOW)).toBe("TRIAL");
    });

    it("trial ended -> EXPIRED", () => {
      const s = sub({ status: "TRIALING", trialEndsAt: new Date(NOW.getTime() - 1) });
      expect(classifyOrganizationLifecycle(s, NOW)).toBe("EXPIRED");
    });
  });

  it("ACTIVE -> PAID", () => {
    const s = sub({ status: "ACTIVE" });
    expect(classifyOrganizationLifecycle(s, NOW)).toBe("PAID");
  });

  describe("PAST_DUE", () => {
    it("still within grace period -> PAID", () => {
      const s = sub({ status: "PAST_DUE", gracePeriodEndsAt: new Date(NOW.getTime() + 1000) });
      expect(classifyOrganizationLifecycle(s, NOW)).toBe("PAID");
    });

    it("boundary: gracePeriodEndsAt exactly now -> PAID (inclusive)", () => {
      const s = sub({ status: "PAST_DUE", gracePeriodEndsAt: NOW });
      expect(classifyOrganizationLifecycle(s, NOW)).toBe("PAID");
    });

    it("grace period exhausted -> SUSPENDED", () => {
      const s = sub({ status: "PAST_DUE", gracePeriodEndsAt: new Date(NOW.getTime() - 1) });
      expect(classifyOrganizationLifecycle(s, NOW)).toBe("SUSPENDED");
    });

    it("no gracePeriodEndsAt set at all -> SUSPENDED (conservative default, matches computeAccessMode)", () => {
      const s = sub({ status: "PAST_DUE", gracePeriodEndsAt: null });
      expect(classifyOrganizationLifecycle(s, NOW)).toBe("SUSPENDED");
    });
  });

  it("UNPAID -> SUSPENDED, always", () => {
    const s = sub({ status: "UNPAID" });
    expect(classifyOrganizationLifecycle(s, NOW)).toBe("SUSPENDED");
  });

  describe("CANCELED — kept distinct from SUSPENDED", () => {
    it("still within the paid period -> PAID", () => {
      const s = sub({ status: "CANCELED", currentPeriodEnd: new Date(NOW.getTime() + 1000) });
      expect(classifyOrganizationLifecycle(s, NOW)).toBe("PAID");
    });

    it("boundary: currentPeriodEnd exactly now -> PAID (inclusive)", () => {
      const s = sub({ status: "CANCELED", currentPeriodEnd: NOW });
      expect(classifyOrganizationLifecycle(s, NOW)).toBe("PAID");
    });

    it("period lapsed -> CANCELED, never SUSPENDED", () => {
      const s = sub({ status: "CANCELED", currentPeriodEnd: new Date(NOW.getTime() - 1) });
      expect(classifyOrganizationLifecycle(s, NOW)).toBe("CANCELED");
    });

    it("no currentPeriodEnd set at all -> CANCELED", () => {
      const s = sub({ status: "CANCELED", currentPeriodEnd: null });
      expect(classifyOrganizationLifecycle(s, NOW)).toBe("CANCELED");
    });
  });

  it("INCOMPLETE -> PAID (unreachable in practice today, kept for exhaustiveness)", () => {
    const s = sub({ status: "INCOMPLETE" });
    expect(classifyOrganizationLifecycle(s, NOW)).toBe("PAID");
  });

  it("ARCHIVED is a valid output type but no input produces it today", () => {
    expect(ORGANIZATION_LIFECYCLE_STATUSES).toContain("ARCHIVED");
  });
});

describe("parseOrganizationListParams", () => {
  it("defaults: empty q, no status, createdAt desc, page 1", () => {
    const params = parseOrganizationListParams({});
    expect(params).toEqual({
      q: "",
      status: undefined,
      sortField: "createdAt",
      sortDir: "desc",
      sortCombined: "createdAt:desc",
      page: 1,
    });
  });

  it("reads q, trimmed", () => {
    expect(parseOrganizationListParams({ q: "  acme  " }).q).toBe("acme");
  });

  it("accepts every valid status value", () => {
    for (const status of ORGANIZATION_LIFECYCLE_STATUSES) {
      expect(parseOrganizationListParams({ status }).status).toBe(status);
    }
  });

  it("an invalid status falls back to undefined (no filter)", () => {
    expect(parseOrganizationListParams({ status: "NOT_A_REAL_STATUS" }).status).toBeUndefined();
  });

  it("accepts name sort ascending", () => {
    const params = parseOrganizationListParams({ sort: "name:asc" });
    expect(params.sortField).toBe("name");
    expect(params.sortDir).toBe("asc");
  });

  it("an invalid sort field falls back to the default field, independent of direction — parseSortParam's own documented shape", () => {
    const params = parseOrganizationListParams({ sort: "notAField:asc" });
    expect(params.sortField).toBe("createdAt");
    expect(params.sortDir).toBe("asc");
    expect(params.sortCombined).toBe("createdAt:asc");
  });

  it("page below 1 falls back to 1", () => {
    expect(parseOrganizationListParams({ page: "0" }).page).toBe(1);
    expect(parseOrganizationListParams({ page: "-5" }).page).toBe(1);
  });
});

describe("buildOrganizationWhere", () => {
  it("no q, no status -> empty where (matches every organization)", () => {
    expect(buildOrganizationWhere({ q: "", status: undefined }, NOW)).toEqual({});
  });

  it("q only -> OR across name/slug/owner email", () => {
    const where = buildOrganizationWhere({ q: "acme", status: undefined }, NOW);
    expect(where.OR).toEqual([
      { name: { contains: "acme", mode: "insensitive" } },
      { slug: { contains: "acme", mode: "insensitive" } },
      { memberships: { some: { role: "OWNER", user: { email: { contains: "acme", mode: "insensitive" } } } } },
    ]);
  });

  it("TRIAL -> TRIALING with trialEndsAt in the future", () => {
    const where = buildOrganizationWhere({ q: "", status: "TRIAL" }, NOW);
    expect(where.subscription).toEqual({ status: "TRIALING", trialEndsAt: { gte: NOW } });
  });

  it("EXPIRED -> TRIALING with trialEndsAt in the past", () => {
    const where = buildOrganizationWhere({ q: "", status: "EXPIRED" }, NOW);
    expect(where.subscription).toEqual({ status: "TRIALING", trialEndsAt: { lt: NOW } });
  });

  it("PAID -> ACTIVE, INCOMPLETE, in-grace PAST_DUE, or in-period CANCELED", () => {
    const where = buildOrganizationWhere({ q: "", status: "PAID" }, NOW);
    expect(where.subscription!.OR).toEqual([
      { status: "ACTIVE" },
      { status: "INCOMPLETE" },
      { status: "PAST_DUE", gracePeriodEndsAt: { gte: NOW } },
      { status: "CANCELED", currentPeriodEnd: { gte: NOW } },
    ]);
  });

  it("SUSPENDED -> UNPAID, or PAST_DUE with grace lapsed/unset", () => {
    const where = buildOrganizationWhere({ q: "", status: "SUSPENDED" }, NOW);
    expect(where.subscription!.OR).toEqual([
      { status: "UNPAID" },
      { status: "PAST_DUE", OR: [{ gracePeriodEndsAt: null }, { gracePeriodEndsAt: { lt: NOW } }] },
    ]);
  });

  it("CANCELED -> status CANCELED with currentPeriodEnd lapsed/unset", () => {
    const where = buildOrganizationWhere({ q: "", status: "CANCELED" }, NOW);
    expect(where.subscription).toEqual({
      status: "CANCELED",
      OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { lt: NOW } }],
    });
  });

  it("LEGACY -> no Subscription row", () => {
    const where = buildOrganizationWhere({ q: "", status: "LEGACY" }, NOW);
    expect(where.subscription).toBeNull();
  });

  it("ARCHIVED -> always-empty result set (no archiving concept exists yet)", () => {
    const where = buildOrganizationWhere({ q: "", status: "ARCHIVED" }, NOW);
    expect(where.id).toEqual({ in: [] });
  });

  it("q and status combine (both conditions present)", () => {
    const where = buildOrganizationWhere({ q: "acme", status: "TRIAL" }, NOW);
    expect(where.subscription).toEqual({ status: "TRIALING", trialEndsAt: { gte: NOW } });
    expect(where.OR).toBeDefined();
  });
});

describe("buildOrganizationOrderBy", () => {
  it("createdAt desc", () => {
    expect(buildOrganizationOrderBy({ sortField: "createdAt", sortDir: "desc" })).toEqual({ createdAt: "desc" });
  });

  it("name asc", () => {
    expect(buildOrganizationOrderBy({ sortField: "name", sortDir: "asc" })).toEqual({ name: "asc" });
  });
});
