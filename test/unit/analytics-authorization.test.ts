import { describe, expect, it } from "vitest";
import { canViewAnalytics, assertCanViewAnalytics, AnalyticsAccessError } from "@/lib/analytics/authorization";

describe("canViewAnalytics", () => {
  it("OWNER can view analytics", () => {
    expect(canViewAnalytics("OWNER")).toBe(true);
  });

  it("ADMIN can view analytics", () => {
    expect(canViewAnalytics("ADMIN")).toBe(true);
  });

  it("MEMBER cannot view analytics (hard block for Stage 1)", () => {
    expect(canViewAnalytics("MEMBER")).toBe(false);
  });
});

describe("assertCanViewAnalytics", () => {
  it("does not throw for OWNER", () => {
    expect(() => assertCanViewAnalytics("OWNER")).not.toThrow();
  });

  it("does not throw for ADMIN", () => {
    expect(() => assertCanViewAnalytics("ADMIN")).not.toThrow();
  });

  it("throws AnalyticsAccessError for MEMBER", () => {
    expect(() => assertCanViewAnalytics("MEMBER")).toThrow(AnalyticsAccessError);
  });
});
