import { describe, expect, it } from "vitest";
import { getBucketUnit, getSeriesBounds, bucketUnitToIntervalLiteral } from "@/lib/analytics/calculations/date-ranges";
import { MAX_CHART_WEEKS } from "@/lib/analytics/constants";

const NOW = new Date("2026-08-12T15:30:00.000Z");

describe("getBucketUnit", () => {
  it("today uses hourly buckets", () => {
    expect(getBucketUnit("today")).toBe("hour");
  });

  it("last7Days and last30Days use daily buckets", () => {
    expect(getBucketUnit("last7Days")).toBe("day");
    expect(getBucketUnit("last30Days")).toBe("day");
  });

  it("last90Days and allTime use weekly buckets", () => {
    expect(getBucketUnit("last90Days")).toBe("week");
    expect(getBucketUnit("allTime")).toBe("week");
  });
});

describe("getSeriesBounds", () => {
  it("matches getTimeRangeBounds for every range except allTime", () => {
    const bounds = getSeriesBounds("last7Days", NOW);
    expect(bounds.end).toEqual(NOW);
    expect(NOW.getTime() - bounds.start!.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("caps allTime to MAX_CHART_WEEKS, never truly unbounded", () => {
    const bounds = getSeriesBounds("allTime", NOW);
    expect(bounds.start).not.toBeNull();
    const days = (NOW.getTime() - bounds.start!.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(MAX_CHART_WEEKS * 7);
  });
});

describe("bucketUnitToIntervalLiteral", () => {
  it("maps every unit to a valid Postgres interval literal", () => {
    expect(bucketUnitToIntervalLiteral("hour")).toBe("1 hour");
    expect(bucketUnitToIntervalLiteral("day")).toBe("1 day");
    expect(bucketUnitToIntervalLiteral("week")).toBe("7 days");
  });
});
