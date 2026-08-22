import { describe, expect, it } from "vitest";
import {
  computeUsageStatus,
  formatCountLabel,
  formatLimitLabel,
  formatStorageLabel,
  APPROACHING_THRESHOLD_RATIO,
} from "@/lib/billing/usage-presentation";

describe("computeUsageStatus", () => {
  it("unlimited (limit null) is always NORMAL with a null percentage, never a fake 100%", () => {
    expect(computeUsageStatus(0, null)).toEqual({ percentage: null, status: "NORMAL", unlimited: true });
    expect(computeUsageStatus(1_000_000, null)).toEqual({ percentage: null, status: "NORMAL", unlimited: true });
  });

  it("just under the approaching threshold (79%) is NORMAL", () => {
    const result = computeUsageStatus(79, 100);
    expect(result.status).toBe("NORMAL");
    expect(result.percentage).toBe(79);
  });

  it("exactly at the approaching threshold (80%) is APPROACHING", () => {
    const result = computeUsageStatus(APPROACHING_THRESHOLD_RATIO * 100, 100);
    expect(result.status).toBe("APPROACHING");
    expect(result.percentage).toBe(80);
  });

  it("exactly 100% is REACHED, not APPROACHING or EXCEEDED", () => {
    const result = computeUsageStatus(100, 100);
    expect(result.status).toBe("REACHED");
    expect(result.percentage).toBe(100);
  });

  it("over 100% is EXCEEDED, and percentage is the true unclamped ratio", () => {
    const result = computeUsageStatus(150, 100);
    expect(result.status).toBe("EXCEEDED");
    expect(result.percentage).toBe(150);
  });

  it("zero limit with zero current is REACHED, not a division-by-zero crash", () => {
    const result = computeUsageStatus(0, 0);
    expect(result.status).toBe("REACHED");
    expect(result.percentage).toBe(100);
    expect(result.unlimited).toBe(false);
  });

  it("zero limit with any usage is EXCEEDED", () => {
    const result = computeUsageStatus(1, 0);
    expect(result.status).toBe("EXCEEDED");
    expect(result.percentage).toBe(100);
  });

  it("rounds a non-integer ratio to the nearest whole percentage", () => {
    const result = computeUsageStatus(1, 3);
    expect(result.percentage).toBe(33);
    expect(result.status).toBe("NORMAL");
  });
});

describe("formatCountLabel", () => {
  it("renders a plain integer with no unit", () => {
    expect(formatCountLabel(0)).toBe("0");
    expect(formatCountLabel(42)).toBe("42");
  });
});

describe("formatStorageLabel", () => {
  it("formats bytes as a human-readable size", () => {
    expect(formatStorageLabel(0)).toBe("0 B");
    expect(formatStorageLabel(500 * 1024 * 1024)).toContain("MB");
    expect(formatStorageLabel(10 * 1024 * 1024 * 1024)).toContain("GB");
  });
});

describe("formatLimitLabel", () => {
  it("renders 'Unlimited' for a null limit", () => {
    expect(formatLimitLabel(null, formatCountLabel)).toBe("Unlimited");
  });

  it("delegates to the given formatter for a real limit", () => {
    expect(formatLimitLabel(10, formatCountLabel)).toBe("10");
    expect(formatLimitLabel(500 * 1024 * 1024, formatStorageLabel)).toContain("MB");
  });
});
