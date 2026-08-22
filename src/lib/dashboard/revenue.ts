import type { DashboardPeriodRange } from "./period";

export type PaidInvoiceRow = {
  /** Prisma.Decimal in production; a plain number is also accepted (tests). */
  amount: unknown;
  paidAt: Date;
};

export type RevenueBucket = {
  /** UTC "YYYY-MM-DD" (day/week bucket) or "YYYY-MM" (month bucket). */
  bucketStart: string;
  amount: number;
};

export type RevenueResult = {
  /** Sum of every row's amount — the same rows the buckets are built from. */
  total: number;
  /** Ascending by bucketStart, including zero-amount buckets. */
  buckets: RevenueBucket[];
};

function utcDayStart(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Monday-start week, computed from the UTC calendar day. */
function utcWeekStart(date: Date): number {
  const dayStart = utcDayStart(date);
  const dow = new Date(dayStart).getUTCDay(); // 0 = Sunday
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;
  return dayStart - daysSinceMonday * 24 * 60 * 60 * 1000;
}

function utcMonthStart(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function formatDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function formatMonthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

type BucketStrategy = {
  bucketStartMs: (date: Date) => number;
  nextMs: (ms: number) => number;
  formatKey: (ms: number) => string;
};

const BUCKET_STRATEGIES: Record<DashboardPeriodRange["bucketUnit"], BucketStrategy> = {
  day: {
    bucketStartMs: utcDayStart,
    nextMs: (ms) => ms + 24 * 60 * 60 * 1000,
    formatKey: formatDayKey,
  },
  week: {
    bucketStartMs: utcWeekStart,
    nextMs: (ms) => ms + 7 * 24 * 60 * 60 * 1000,
    formatKey: formatDayKey,
  },
  month: {
    bucketStartMs: utcMonthStart,
    nextMs: (ms) => {
      const d = new Date(ms);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    },
    formatKey: formatMonthKey,
  },
};

/**
 * Buckets a set of already-fetched PAID/paidAt-not-null Invoice rows into a
 * time series matching the period's bucket unit (day for 7d/30d, week for
 * 90d, month for year). Every bucket between the range's start and end is
 * present, even when its amount is 0, so a chart never silently collapses a
 * quiet day/week/month. Pure function — no Prisma import, no I/O — takes
 * the exact rows the caller already fetched for the revenue KPI, so the
 * total and the time series always come from one dataset, never two
 * separate queries.
 */
export function bucketRevenue(rows: PaidInvoiceRow[], range: DashboardPeriodRange): RevenueResult {
  const strategy = BUCKET_STRATEGIES[range.bucketUnit];

  const buckets = new Map<string, number>();
  const startMs = strategy.bucketStartMs(range.start);
  const endMs = strategy.bucketStartMs(range.end);
  for (let ms = startMs; ms <= endMs; ms = strategy.nextMs(ms)) {
    buckets.set(strategy.formatKey(ms), 0);
  }

  let total = 0;
  for (const row of rows) {
    const amount = Number(row.amount);
    total += amount;

    const key = strategy.formatKey(strategy.bucketStartMs(row.paidAt));
    // A row's own bucket key is always within [startMs, endMs] since the
    // caller already filtered paidAt to the period range — but guard
    // against ever creating an extra bucket if that invariant is violated.
    if (buckets.has(key)) {
      buckets.set(key, (buckets.get(key) ?? 0) + amount);
    }
  }

  const orderedBuckets = Array.from(buckets.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([bucketStart, amount]) => ({ bucketStart, amount }));

  return { total, buckets: orderedBuckets };
}
