import { describe, expect, it } from "vitest";
import { isPurchasablePlanKey } from "@/lib/billing/plan-selection";

describe("isPurchasablePlanKey", () => {
  it("accepts STARTER and PRO — the two real, purchasable plans", () => {
    expect(isPurchasablePlanKey("STARTER")).toBe(true);
    expect(isPurchasablePlanKey("PRO")).toBe(true);
  });

  it("rejects TRIAL — a real plan key, but never purchasable", () => {
    expect(isPurchasablePlanKey("TRIAL")).toBe(false);
  });

  it("rejects LEGACY — a real plan key, but never purchasable", () => {
    expect(isPurchasablePlanKey("LEGACY")).toBe(false);
  });

  it("rejects an unrecognized plan key", () => {
    expect(isPurchasablePlanKey("ENTERPRISE")).toBe(false);
    expect(isPurchasablePlanKey("")).toBe(false);
  });

  it("rejects a prototype-chain property name (not a real catalog entry)", () => {
    expect(isPurchasablePlanKey("toString")).toBe(false);
  });
});
