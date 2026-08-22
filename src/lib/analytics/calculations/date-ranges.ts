import { MS_PER_DAY, TIME_RANGE_DAYS, MAX_CHART_WEEKS } from "../constants";
import type { BucketUnit, TimeRange, TimeRangeBounds } from "../types";

/**
 * Analytics Stage 1 (docs/analytics-architecture.md §4). Pure — takes
 * `now` explicitly (never reads the system clock itself) so every caller,
 * and every test, gets a deterministic, reproducible window. Rolling
 * windows (`now - N days` to `now`), not calendar-aligned ones — see
 * `getCalendarBoundaries` below for the one place this codebase wants
 * calendar alignment instead (Activity metrics' "today/this week/this
 * month").
 */
export function getTimeRangeBounds(timeRange: TimeRange, now: Date): TimeRangeBounds {
  if (timeRange === "allTime") {
    return { start: null, end: now };
  }

  const days = TIME_RANGE_DAYS[timeRange];
  if (days === undefined) {
    throw new Error(`Unhandled TimeRange: ${timeRange}`);
  }

  return { start: new Date(now.getTime() - days * MS_PER_DAY), end: now };
}

/**
 * The "previous equal-length period" immediately before `bounds.start` —
 * e.g. for `last7Days` (days 0–7 ago), this returns days 7–14 ago. Used
 * exclusively by growth metrics (queries/growth-metrics.ts) to compare
 * "this period" against "the one just like it, right before it". Throws
 * for `allTime`/`start: null` — there is no period before all time; a
 * caller must resolve `allTime` to `DEFAULT_GROWTH_TIME_RANGE` first (see
 * constants.ts's own doc comment on that constant).
 */
export function getPreviousPeriodBounds(bounds: TimeRangeBounds): TimeRangeBounds {
  if (bounds.start === null) {
    throw new Error("getPreviousPeriodBounds: bounds.start is null (allTime has no previous period)");
  }

  const durationMs = bounds.end.getTime() - bounds.start.getTime();
  return {
    start: new Date(bounds.start.getTime() - durationMs),
    end: bounds.start,
  };
}

/** UTC midnight (00:00:00.000) of the same calendar day as `now`. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Monday 00:00:00.000 UTC of the ISO week containing `now` (ISO weeks start Monday, unlike `Date.getUTCDay()`'s own Sunday-start numbering). */
export function startOfUtcWeek(now: Date): Date {
  const dayOfWeek = now.getUTCDay(); // 0 (Sun) .. 6 (Sat)
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const start = startOfUtcDay(now);
  return new Date(start.getTime() - daysSinceMonday * MS_PER_DAY);
}

/** The 1st of the UTC calendar month containing `now`, at 00:00:00.000. */
export function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Analytics Stage 3 (docs/analytics-architecture.md §10's "adaptive
 * axes"). The bucket size a chart uses for a given `TimeRange` — never
 * fixed, so `today` isn't 24 empty-looking daily points and `last90Days`
 * isn't ~2,160 unreadable hourly ones:
 *
 * - `today` → hourly (24 buckets)
 * - `last7Days` / `last30Days` → daily (7 / 30 buckets)
 * - `last90Days` / `allTime` → weekly (~13 buckets / capped at `MAX_CHART_WEEKS`)
 */
export function getBucketUnit(timeRange: TimeRange): BucketUnit {
  if (timeRange === "today") return "hour";
  if (timeRange === "last7Days" || timeRange === "last30Days") return "day";
  return "week"; // last90Days, allTime
}

/**
 * The bounds a chart's series query actually runs over — identical to
 * `getTimeRangeBounds` for every range except `allTime`, which this caps
 * to the last `MAX_CHART_WEEKS` weeks (see that constant's own doc
 * comment for why). Every other analytics metric still uses
 * `getTimeRangeBounds` directly and sees `allTime` literally.
 */
export function getSeriesBounds(timeRange: TimeRange, now: Date): TimeRangeBounds {
  if (timeRange !== "allTime") {
    return getTimeRangeBounds(timeRange, now);
  }
  return { start: new Date(now.getTime() - MAX_CHART_WEEKS * 7 * MS_PER_DAY), end: now };
}

/** Postgres `interval` literal for one bucket of the given unit — used only to advance `generate_series()`'s step in the raw time-series queries (queries/time-series.ts). */
export function bucketUnitToIntervalLiteral(unit: BucketUnit): string {
  return { hour: "1 hour", day: "1 day", week: "7 days" }[unit];
}

/**
 * Calendar-aligned boundaries for Activity metrics' fixed "today / this
 * week / this month" questions (types.ts's own `ActivityMetrics`) — these
 * always mean the same thing regardless of whatever TimeRange the caller
 * separately selected for growth metrics, so they're computed once, here,
 * independently of `getTimeRangeBounds`.
 */
export function getCalendarBoundaries(now: Date): { today: Date; thisWeek: Date; thisMonth: Date } {
  return {
    today: startOfUtcDay(now),
    thisWeek: startOfUtcWeek(now),
    thisMonth: startOfUtcMonth(now),
  };
}
