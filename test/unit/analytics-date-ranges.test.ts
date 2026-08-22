import { describe, expect, it } from "vitest";
import {
  getTimeRangeBounds,
  getPreviousPeriodBounds,
  startOfUtcDay,
  startOfUtcWeek,
  startOfUtcMonth,
  getCalendarBoundaries,
} from "@/lib/analytics/calculations/date-ranges";

// A fixed, deterministic instant: Wednesday 2026-08-12T15:30:00.000Z.
const NOW = new Date("2026-08-12T15:30:00.000Z");

describe("getTimeRangeBounds", () => {
  it("allTime has no lower bound", () => {
    const bounds = getTimeRangeBounds("allTime", NOW);
    expect(bounds.start).toBeNull();
    expect(bounds.end).toEqual(NOW);
  });

  it("today is a rolling 24h window ending now", () => {
    const bounds = getTimeRangeBounds("today", NOW);
    expect(bounds.start?.toISOString()).toBe("2026-08-11T15:30:00.000Z");
    expect(bounds.end).toEqual(NOW);
  });

  it("last7Days is exactly 7*24h before now", () => {
    const bounds = getTimeRangeBounds("last7Days", NOW);
    expect(bounds.start?.toISOString()).toBe("2026-08-05T15:30:00.000Z");
  });

  it("last30Days and last90Days scale linearly with MS_PER_DAY", () => {
    const b30 = getTimeRangeBounds("last30Days", NOW);
    const b90 = getTimeRangeBounds("last90Days", NOW);
    expect(NOW.getTime() - b30.start!.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    expect(NOW.getTime() - b90.start!.getTime()).toBe(90 * 24 * 60 * 60 * 1000);
  });
});

describe("getPreviousPeriodBounds", () => {
  it("returns the equal-length window immediately before bounds.start", () => {
    const bounds = getTimeRangeBounds("last7Days", NOW);
    const previous = getPreviousPeriodBounds(bounds);
    expect(previous.end).toEqual(bounds.start);
    expect(bounds.start!.getTime() - previous.start!.getTime()).toBe(bounds.end.getTime() - bounds.start!.getTime());
  });

  it("throws for allTime (no period before all time)", () => {
    const bounds = getTimeRangeBounds("allTime", NOW);
    expect(() => getPreviousPeriodBounds(bounds)).toThrow();
  });
});

describe("calendar boundaries", () => {
  it("startOfUtcDay is UTC midnight of the same day", () => {
    expect(startOfUtcDay(NOW).toISOString()).toBe("2026-08-12T00:00:00.000Z");
  });

  it("startOfUtcWeek is Monday 00:00 UTC (ISO week, not Sunday-start)", () => {
    // 2026-08-12 is a Wednesday; the Monday of that ISO week is 2026-08-10.
    expect(startOfUtcWeek(NOW).toISOString()).toBe("2026-08-10T00:00:00.000Z");
  });

  it("startOfUtcWeek on a Sunday rolls back to the previous Monday, not forward", () => {
    const sunday = new Date("2026-08-16T12:00:00.000Z");
    expect(startOfUtcWeek(sunday).toISOString()).toBe("2026-08-10T00:00:00.000Z");
  });

  it("startOfUtcMonth is the 1st of the UTC month at midnight", () => {
    expect(startOfUtcMonth(NOW).toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("getCalendarBoundaries bundles all three consistently", () => {
    const { today, thisWeek, thisMonth } = getCalendarBoundaries(NOW);
    expect(today.toISOString()).toBe("2026-08-12T00:00:00.000Z");
    expect(thisWeek.toISOString()).toBe("2026-08-10T00:00:00.000Z");
    expect(thisMonth.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });
});
