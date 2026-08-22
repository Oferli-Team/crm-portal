export type DashboardPeriod = "7d" | "30d" | "90d" | "year";

export const DASHBOARD_PERIODS = ["7d", "30d", "90d", "year"] as const satisfies readonly DashboardPeriod[];

export const DEFAULT_DASHBOARD_PERIOD: DashboardPeriod = "30d";

export const DASHBOARD_PERIOD_OPTIONS: readonly { value: DashboardPeriod; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "year", label: "Year to date" },
];

const DASHBOARD_PERIOD_HINTS: Record<DashboardPeriod, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  year: "Year to date",
};

/** Short human label for period-scoped values (the Paid revenue KPI, the revenue chart caption). */
export function formatDashboardPeriodLabel(period: DashboardPeriod): string {
  return DASHBOARD_PERIOD_HINTS[period];
}

/**
 * Any value that isn't exactly one of the four known periods silently
 * falls back to the default — never an error, matching the existing
 * parseEnumParam convention used elsewhere in the app (e.g. Activity's
 * entityType/actionGroup filters).
 */
export function parseDashboardPeriod(value: string | string[] | undefined): DashboardPeriod {
  const raw = Array.isArray(value) ? value[0] : value;
  return (DASHBOARD_PERIODS as readonly string[]).includes(raw ?? "")
    ? (raw as DashboardPeriod)
    : DEFAULT_DASHBOARD_PERIOD;
}

export type DashboardBucketUnit = "day" | "week" | "month";

export type DashboardPeriodRange = {
  period: DashboardPeriod;
  /** Inclusive lower bound. */
  start: Date;
  /** Inclusive upper bound — always the `now` passed in, never re-derived. */
  end: Date;
  bucketUnit: DashboardBucketUnit;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolves the [start, end] window for a period, plus which bucket size its
 * revenue time series should use. `now` is always a caller-supplied
 * parameter — this never calls `new Date()` itself — so the same instant
 * can be reused across every query in one request and asserted on exactly
 * in tests.
 *
 * 7d/30d/90d are rolling windows ending at `now` (not aligned to a
 * calendar-day boundary). `year` is year-to-date: from January 1st,
 * 00:00:00 UTC of `now`'s UTC year, through `now`. All boundaries are UTC —
 * this app does no per-user timezone handling anywhere today (see the
 * Activity date filter for the same precedent), and this doesn't introduce
 * any.
 */
export function getDashboardPeriodRange(period: DashboardPeriod, now: Date): DashboardPeriodRange {
  if (period === "year") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0, 0));
    return { period, start, end: now, bucketUnit: "month" };
  }

  const days = period === "7d" ? 7 : period === "30d" ? 30 : 90;
  const start = new Date(now.getTime() - days * DAY_MS);
  const bucketUnit: DashboardBucketUnit = period === "90d" ? "week" : "day";
  return { period, start, end: now, bucketUnit };
}
