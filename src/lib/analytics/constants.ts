import { ALL_TIME_RANGES, type TimeRange } from "./types";

/** Display labels for the (future) range selector — Stage 1 defines these alongside the type so UI/service never invent their own copy independently. */
export const TIME_RANGE_LABELS: Readonly<Record<TimeRange, string>> = {
  today: "Today",
  last7Days: "Last 7 days",
  last30Days: "Last 30 days",
  last90Days: "Last 90 days",
  allTime: "All time",
};

export const DEFAULT_TIME_RANGE: TimeRange = "last30Days";

/**
 * Growth metrics (queries/growth-metrics.ts) need a genuine "previous
 * equal-length period" to compare against — `allTime` has no such period
 * (there is no "before all time"). Growth for `allTime` is computed as
 * if `DEFAULT_GROWTH_TIME_RANGE` had been requested instead; every other
 * metric in the snapshot still honors `allTime` literally.
 */
export const DEFAULT_GROWTH_TIME_RANGE: TimeRange = "last30Days";

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const TIME_RANGE_DAYS: Readonly<Partial<Record<TimeRange, number>>> = {
  today: 1,
  last7Days: 7,
  last30Days: 30,
  last90Days: 90,
};

/**
 * Analytics Stage 2 (docs/analytics-architecture.md §4's own "the URL is
 * the one source of truth for the selected range — never a cookie"
 * decision). Pure — a single, safe way to turn a raw `?range=` query
 * value (or its absence, or an unrecognized string, or the `string[]`
 * shape Next.js gives a repeated query key) into a real `TimeRange`,
 * never throwing and never trusting the input. `page.tsx` is the only
 * caller; every other analytics entry point still takes a real
 * `TimeRange`, never a raw string.
 */
export function parseTimeRangeParam(value: string | string[] | undefined): TimeRange {
  const candidate = Array.isArray(value) ? value[0] : value;
  return (ALL_TIME_RANGES as readonly string[]).includes(candidate ?? "") ? (candidate as TimeRange) : DEFAULT_TIME_RANGE;
}

/**
 * Analytics Stage 3 (docs/analytics-architecture.md §10). `allTime`'s
 * chart series is deliberately NOT literal all-time — an organization
 * several years old would otherwise produce hundreds of weekly buckets
 * (and the single aggregate query behind it would scan that whole
 * history every request). Capped to the last year of weekly buckets;
 * `allTime`'s own *total* counts (types.ts's `OrganizationMetrics`, not
 * this) are still computed over the organization's entire real history,
 * unaffected by this cap — only the chart's x-axis window is bounded.
 */
export const MAX_CHART_WEEKS = 52;
