import { describe, expect, it } from "vitest";
import {
  parseDashboardPeriod,
  getDashboardPeriodRange,
  formatDashboardPeriodLabel,
} from "@/lib/dashboard/period";
import { FIXED_NOW } from "../support/fixtures";

describe("parseDashboardPeriod", () => {
  it.each(["7d", "30d", "90d", "year"] as const)("accepts %s", (period) => {
    expect(parseDashboardPeriod(period)).toBe(period);
  });

  it("falls back to 30d for an invalid value", () => {
    expect(parseDashboardPeriod("bogus")).toBe("30d");
  });

  it("falls back to 30d for undefined", () => {
    expect(parseDashboardPeriod(undefined)).toBe("30d");
  });

  it("falls back to 30d for an empty string", () => {
    expect(parseDashboardPeriod("")).toBe("30d");
  });

  it("takes the first element of an array value", () => {
    expect(parseDashboardPeriod(["90d", "year"])).toBe("90d");
  });

  it("falls back to 30d for an empty array", () => {
    expect(parseDashboardPeriod([])).toBe("30d");
  });
});

describe("getDashboardPeriodRange", () => {
  it("computes a rolling 7-day window with a day bucket", () => {
    const range = getDashboardPeriodRange("7d", FIXED_NOW);
    expect(range.end).toBe(FIXED_NOW);
    expect(range.start.getTime()).toBe(FIXED_NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
    expect(range.bucketUnit).toBe("day");
  });

  it("computes a rolling 30-day window with a day bucket", () => {
    const range = getDashboardPeriodRange("30d", FIXED_NOW);
    expect(range.start.getTime()).toBe(FIXED_NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(range.bucketUnit).toBe("day");
  });

  it("computes a rolling 90-day window with a week bucket", () => {
    const range = getDashboardPeriodRange("90d", FIXED_NOW);
    expect(range.start.getTime()).toBe(FIXED_NOW.getTime() - 90 * 24 * 60 * 60 * 1000);
    expect(range.bucketUnit).toBe("week");
  });

  it("computes year-to-date starting January 1st 00:00:00 UTC, with a month bucket", () => {
    const range = getDashboardPeriodRange("year", FIXED_NOW);
    expect(range.start.toISOString()).toBe(`${FIXED_NOW.getUTCFullYear()}-01-01T00:00:00.000Z`);
    expect(range.end).toBe(FIXED_NOW);
    expect(range.bucketUnit).toBe("month");
  });

  it("always uses the caller-supplied now, never the real current time", () => {
    const arbitraryNow = new Date("2019-03-03T00:00:00.000Z");
    const range = getDashboardPeriodRange("30d", arbitraryNow);
    expect(range.end).toBe(arbitraryNow);
    expect(range.start.toISOString()).toBe("2019-02-01T00:00:00.000Z");
  });
});

describe("formatDashboardPeriodLabel", () => {
  it("returns the expected human label for every period", () => {
    expect(formatDashboardPeriodLabel("7d")).toBe("Last 7 days");
    expect(formatDashboardPeriodLabel("30d")).toBe("Last 30 days");
    expect(formatDashboardPeriodLabel("90d")).toBe("Last 90 days");
    expect(formatDashboardPeriodLabel("year")).toBe("Year to date");
  });
});
