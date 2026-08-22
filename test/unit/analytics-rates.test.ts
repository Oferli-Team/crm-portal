import { describe, expect, it } from "vitest";
import { calculateCompletionRate, calculateGrowthRate } from "@/lib/analytics/calculations/rates";

describe("calculateCompletionRate", () => {
  it("returns 0, not NaN, when total is 0", () => {
    expect(calculateCompletionRate(0, 0)).toBe(0);
  });

  it("computes a rounded percentage", () => {
    expect(calculateCompletionRate(1, 3)).toBe(33);
    expect(calculateCompletionRate(2, 3)).toBe(67);
    expect(calculateCompletionRate(5, 10)).toBe(50);
  });

  it("100% when completed equals total", () => {
    expect(calculateCompletionRate(10, 10)).toBe(100);
  });

  it("negative total is treated the same as 0 (defensive, never divides)", () => {
    expect(calculateCompletionRate(0, -1)).toBe(0);
  });
});

describe("calculateGrowthRate", () => {
  it("returns null, not Infinity/NaN, when previous is 0", () => {
    expect(calculateGrowthRate(5, 0)).toBeNull();
  });

  it("returns null when previous is negative (defensive)", () => {
    expect(calculateGrowthRate(5, -1)).toBeNull();
  });

  it("computes positive growth", () => {
    expect(calculateGrowthRate(15, 10)).toBe(50);
  });

  it("computes negative growth (decline)", () => {
    expect(calculateGrowthRate(5, 10)).toBe(-50);
  });

  it("0% when current equals previous", () => {
    expect(calculateGrowthRate(10, 10)).toBe(0);
  });

  it("rounds to the nearest integer percent", () => {
    expect(calculateGrowthRate(11, 10)).toBe(10);
    expect(calculateGrowthRate(13, 10)).toBe(30);
  });
});
