import { describe, expect, it } from "vitest";
import {
  PLAN_CATALOG,
  ALL_PLAN_KEYS,
  DEFAULT_TRIAL_PLAN_KEY,
  LEGACY_PLAN_KEY,
  TRIAL_DURATION_DAYS,
  getPlan,
  isPlanKey,
} from "@/lib/billing/plans";

describe("PLAN_CATALOG — every key is well-formed", () => {
  it("every plan key resolves to a plan whose own `key` matches", () => {
    for (const key of ALL_PLAN_KEYS) {
      expect(PLAN_CATALOG[key].key).toBe(key);
    }
  });

  it("every plan has a non-empty displayName", () => {
    for (const key of ALL_PLAN_KEYS) {
      expect(PLAN_CATALOG[key].displayName.length).toBeGreaterThan(0);
    }
  });

  it("no limit is negative", () => {
    for (const key of ALL_PLAN_KEYS) {
      const { limits } = PLAN_CATALOG[key];
      expect(limits.maxMembers).toBeGreaterThanOrEqual(0);
      expect(limits.maxStorageBytes).toBeGreaterThanOrEqual(0);
      if (limits.maxClients !== null) expect(limits.maxClients).toBeGreaterThanOrEqual(0);
      if (limits.maxProjects !== null) expect(limits.maxProjects).toBeGreaterThanOrEqual(0);
    }
  });

  it("maxMembers and maxStorageBytes are always concrete numbers, never null (by type — this asserts the runtime shape matches)", () => {
    for (const key of ALL_PLAN_KEYS) {
      const { limits } = PLAN_CATALOG[key];
      expect(typeof limits.maxMembers).toBe("number");
      expect(typeof limits.maxStorageBytes).toBe("number");
    }
  });
});

describe("TRIAL plan", () => {
  it("has a trialDays value equal to TRIAL_DURATION_DAYS", () => {
    expect(PLAN_CATALOG.TRIAL.trialDays).toBe(TRIAL_DURATION_DAYS);
  });

  it("TRIAL_DURATION_DAYS is 14", () => {
    expect(TRIAL_DURATION_DAYS).toBe(14);
  });

  it("is never billing-available (never purchased directly)", () => {
    expect(PLAN_CATALOG.TRIAL.billingAvailable).toBe(false);
  });

  it("mirrors PRO's limits (design intent: trial never hits an artificial ceiling before a plan is chosen)", () => {
    expect(PLAN_CATALOG.TRIAL.limits).toEqual(PLAN_CATALOG.PRO.limits);
  });

  it("is the DEFAULT_TRIAL_PLAN_KEY", () => {
    expect(DEFAULT_TRIAL_PLAN_KEY).toBe("TRIAL");
  });
});

describe("STARTER / PRO plans", () => {
  it("are billing-available", () => {
    expect(PLAN_CATALOG.STARTER.billingAvailable).toBe(true);
    expect(PLAN_CATALOG.PRO.billingAvailable).toBe(true);
  });

  it("have no trialDays (only TRIAL does)", () => {
    expect(PLAN_CATALOG.STARTER.trialDays).toBeNull();
    expect(PLAN_CATALOG.PRO.trialDays).toBeNull();
  });

  it("PRO's limits are each greater than or equal to STARTER's (a real upgrade path)", () => {
    expect(PLAN_CATALOG.PRO.limits.maxMembers).toBeGreaterThan(PLAN_CATALOG.STARTER.limits.maxMembers);
    expect(PLAN_CATALOG.PRO.limits.maxStorageBytes).toBeGreaterThan(PLAN_CATALOG.STARTER.limits.maxStorageBytes);
    // null (unlimited) counts as "at least as generous" as any finite STARTER number.
    expect(PLAN_CATALOG.PRO.limits.maxClients).toBeNull();
    expect(PLAN_CATALOG.PRO.limits.maxProjects).toBeNull();
  });
});

describe("LEGACY plan", () => {
  it("is never billing-available (never sold, never chosen by a user)", () => {
    expect(PLAN_CATALOG.LEGACY.billingAvailable).toBe(false);
  });

  it("has no trialDays", () => {
    expect(PLAN_CATALOG.LEGACY.trialDays).toBeNull();
  });

  it("is at least as generous as PRO on every dimension (never a regression for a pre-billing org)", () => {
    expect(PLAN_CATALOG.LEGACY.limits.maxMembers).toBeGreaterThanOrEqual(PLAN_CATALOG.PRO.limits.maxMembers);
    expect(PLAN_CATALOG.LEGACY.limits.maxStorageBytes).toBeGreaterThanOrEqual(PLAN_CATALOG.PRO.limits.maxStorageBytes);
    expect(PLAN_CATALOG.LEGACY.limits.maxClients).toBeNull();
    expect(PLAN_CATALOG.LEGACY.limits.maxProjects).toBeNull();
  });

  it("is the LEGACY_PLAN_KEY constant", () => {
    expect(LEGACY_PLAN_KEY).toBe("LEGACY");
  });
});

describe("getPlan / isPlanKey", () => {
  it("getPlan returns the exact catalog entry for a valid key", () => {
    expect(getPlan("PRO")).toBe(PLAN_CATALOG.PRO);
  });

  it("isPlanKey is true for every real key", () => {
    for (const key of ALL_PLAN_KEYS) {
      expect(isPlanKey(key)).toBe(true);
    }
  });

  it("isPlanKey is false for an unknown string, including plausible-looking ones", () => {
    expect(isPlanKey("ENTERPRISE")).toBe(false);
    expect(isPlanKey("pro")).toBe(false); // case-sensitive — catalog keys are uppercase
    expect(isPlanKey("")).toBe(false);
    expect(isPlanKey("toString")).toBe(false); // must not resolve via the Object prototype chain
  });
});

describe("No provider IDs or secrets anywhere in the catalog", () => {
  it("no plan or its limits contain a price/product/customer id field, or anything env-var-shaped", () => {
    const serialized = JSON.stringify(PLAN_CATALOG);
    expect(serialized).not.toMatch(/price/i);
    expect(serialized).not.toMatch(/paddle/i);
    expect(serialized).not.toMatch(/stripe/i);
    expect(serialized).not.toMatch(/secret/i);
    expect(serialized).not.toMatch(/_key\b/i);
  });
});
