import { describe, expect, it } from "vitest";
import { bucketRevenue } from "@/lib/dashboard/revenue";
import type { DashboardPeriodRange } from "@/lib/dashboard/period";
import { decimal } from "../support/fixtures";

function dayRange(start: string, end: string): DashboardPeriodRange {
  return { period: "30d", start: new Date(start), end: new Date(end), bucketUnit: "day" };
}

describe("bucketRevenue", () => {
  it("creates zero-filled buckets for empty input", () => {
    const range = dayRange("2026-06-01T00:00:00.000Z", "2026-06-03T00:00:00.000Z");
    const result = bucketRevenue([], range);
    expect(result.total).toBe(0);
    expect(result.buckets).toEqual([
      { bucketStart: "2026-06-01", amount: 0 },
      { bucketStart: "2026-06-02", amount: 0 },
      { bucketStart: "2026-06-03", amount: 0 },
    ]);
  });

  it("buckets by day", () => {
    const range = dayRange("2026-06-01T00:00:00.000Z", "2026-06-02T00:00:00.000Z");
    const result = bucketRevenue(
      [{ amount: 100, paidAt: new Date("2026-06-01T15:00:00.000Z") }],
      range,
    );
    expect(result.buckets).toEqual([
      { bucketStart: "2026-06-01", amount: 100 },
      { bucketStart: "2026-06-02", amount: 0 },
    ]);
  });

  it("buckets by month", () => {
    const range: DashboardPeriodRange = {
      period: "year",
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-03-01T00:00:00.000Z"),
      bucketUnit: "month",
    };
    const result = bucketRevenue(
      [{ amount: 500, paidAt: new Date("2026-02-14T00:00:00.000Z") }],
      range,
    );
    expect(result.buckets).toEqual([
      { bucketStart: "2026-01", amount: 0 },
      { bucketStart: "2026-02", amount: 500 },
      { bucketStart: "2026-03", amount: 0 },
    ]);
  });

  it("buckets by week, aligned to Monday", () => {
    const range: DashboardPeriodRange = {
      period: "90d",
      start: new Date("2026-06-08T00:00:00.000Z"), // a Monday
      end: new Date("2026-06-14T00:00:00.000Z"), // the following Sunday
      bucketUnit: "week",
    };
    const result = bucketRevenue([], range);
    expect(result.buckets).toHaveLength(1);
    const bucketDate = new Date(`${result.buckets[0].bucketStart}T00:00:00.000Z`);
    expect(bucketDate.getUTCDay()).toBe(1); // Monday
  });

  it("assigns a mid-week row to its Monday-aligned week bucket", () => {
    const range: DashboardPeriodRange = {
      period: "90d",
      start: new Date("2026-06-08T00:00:00.000Z"), // Monday
      end: new Date("2026-06-14T00:00:00.000Z"), // Sunday
      bucketUnit: "week",
    };
    // Wednesday within that same week.
    const result = bucketRevenue([{ amount: 42, paidAt: new Date("2026-06-10T09:00:00.000Z") }], range);
    expect(result.buckets).toEqual([{ bucketStart: "2026-06-08", amount: 42 }]);
  });

  it("returns buckets in ascending order regardless of input row order", () => {
    const range = dayRange("2026-06-01T00:00:00.000Z", "2026-06-05T00:00:00.000Z");
    const result = bucketRevenue(
      [
        { amount: 3, paidAt: new Date("2026-06-05T00:00:00.000Z") },
        { amount: 1, paidAt: new Date("2026-06-01T00:00:00.000Z") },
        { amount: 2, paidAt: new Date("2026-06-03T00:00:00.000Z") },
      ],
      range,
    );
    const keys = result.buckets.map((b) => b.bucketStart);
    expect(keys).toEqual([...keys].sort());
  });

  it("never produces duplicate bucket keys, even with multiple rows in the same bucket", () => {
    const range = dayRange("2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z");
    const result = bucketRevenue(
      [
        { amount: 10, paidAt: new Date("2026-06-01T01:00:00.000Z") },
        { amount: 20, paidAt: new Date("2026-06-01T23:00:00.000Z") },
      ],
      range,
    );
    expect(result.buckets).toEqual([{ bucketStart: "2026-06-01", amount: 30 }]);
  });

  it("sums Prisma.Decimal amounts correctly", () => {
    const range = dayRange("2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z");
    const result = bucketRevenue(
      [
        { amount: decimal("10.50"), paidAt: new Date("2026-06-01T01:00:00.000Z") },
        { amount: decimal("5.25"), paidAt: new Date("2026-06-01T02:00:00.000Z") },
      ],
      range,
    );
    expect(result.total).toBeCloseTo(15.75, 5);
    expect(result.buckets[0].amount).toBeCloseTo(15.75, 5);
  });

  it("still totals an out-of-range row, but drops it from the bucket series", () => {
    const range = dayRange("2026-06-01T00:00:00.000Z", "2026-06-02T00:00:00.000Z");
    const result = bucketRevenue(
      [
        { amount: 100, paidAt: new Date("2026-06-01T00:00:00.000Z") },
        { amount: 999, paidAt: new Date("2099-01-01T00:00:00.000Z") }, // far outside the range
      ],
      range,
    );
    expect(result.total).toBe(1099);
    expect(result.buckets).toEqual([
      { bucketStart: "2026-06-01", amount: 100 },
      { bucketStart: "2026-06-02", amount: 0 },
    ]);
    expect(result.buckets.some((b) => b.bucketStart.startsWith("2099"))).toBe(false);
  });

  it("includes rows landing exactly on the range's start and end boundaries", () => {
    const range = dayRange("2026-06-01T00:00:00.000Z", "2026-06-03T00:00:00.000Z");
    const result = bucketRevenue(
      [
        { amount: 1, paidAt: new Date("2026-06-01T00:00:00.000Z") },
        { amount: 2, paidAt: new Date("2026-06-03T00:00:00.000Z") },
      ],
      range,
    );
    expect(result.buckets).toEqual([
      { bucketStart: "2026-06-01", amount: 1 },
      { bucketStart: "2026-06-02", amount: 0 },
      { bucketStart: "2026-06-03", amount: 2 },
    ]);
  });

  it("handles a leap-year month boundary (Feb 29) without error", () => {
    const range: DashboardPeriodRange = {
      period: "year",
      start: new Date("2028-01-15T00:00:00.000Z"),
      end: new Date("2028-03-15T00:00:00.000Z"),
      bucketUnit: "month",
    };
    const result = bucketRevenue([{ amount: 77, paidAt: new Date("2028-02-29T00:00:00.000Z") }], range);
    expect(result.buckets).toEqual([
      { bucketStart: "2028-01", amount: 0 },
      { bucketStart: "2028-02", amount: 77 },
      { bucketStart: "2028-03", amount: 0 },
    ]);
  });
});
