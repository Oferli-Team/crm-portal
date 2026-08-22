import { formatCurrency } from "@/lib/format";
import { formatDashboardPeriodLabel, type DashboardBucketUnit, type DashboardPeriod } from "@/lib/dashboard/period";
import type { RevenueBucket } from "@/lib/dashboard/revenue";

const BAR_MAX_HEIGHT_PX = 160;

function formatBucketLabel(bucketStart: string, unit: DashboardBucketUnit): string {
  const iso = unit === "month" ? `${bucketStart}-01T00:00:00Z` : `${bucketStart}T00:00:00Z`;
  const date = new Date(iso);
  return unit === "month"
    ? date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Plain CSS bars — no chart library. Every bucket the query layer produced
 * (including zero-amount ones) gets a bar, so a quiet stretch never
 * collapses the series into something that looks broken. Labels below bars
 * are thinned out past ~14 buckets purely to avoid overlapping text; every
 * bar still carries its exact value via a screen-reader-only span and a
 * native `title` (hover), regardless of whether its label is visible.
 */
export function RevenueChart({
  buckets,
  bucketUnit,
  total,
  period,
}: {
  buckets: RevenueBucket[];
  bucketUnit: DashboardBucketUnit;
  total: number;
  period: DashboardPeriod;
}) {
  const max = Math.max(...buckets.map((b) => b.amount), 1);
  const labelEvery = buckets.length <= 14 ? 1 : Math.ceil(buckets.length / 8);
  const isEmpty = total === 0;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-semibold text-gray-900">Revenue over time</h3>
        <p className="text-xs text-gray-500">{formatDashboardPeriodLabel(period)}</p>
      </div>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-gray-900">
        {formatCurrency(total)}
      </p>

      {isEmpty ? (
        <p className="mt-6 text-sm text-gray-500">No paid invoices in this period.</p>
      ) : (
        <div
          role="img"
          aria-label={`Paid revenue over ${formatDashboardPeriodLabel(period).toLowerCase()}, total ${formatCurrency(total)}`}
          className="mt-6 flex items-end gap-0.5"
          style={{ height: BAR_MAX_HEIGHT_PX }}
        >
          {buckets.map((bucket, index) => {
            const heightPx = Math.max((bucket.amount / max) * BAR_MAX_HEIGHT_PX, bucket.amount > 0 ? 3 : 1);
            const showLabel = index % labelEvery === 0 || index === buckets.length - 1;
            const label = formatBucketLabel(bucket.bucketStart, bucketUnit);
            return (
              <div key={bucket.bucketStart} className="flex flex-1 flex-col items-center justify-end gap-1">
                <div
                  title={`${label}: ${formatCurrency(bucket.amount)}`}
                  className={`w-full rounded-t ${bucket.amount > 0 ? "bg-gray-900" : "bg-gray-100"}`}
                  style={{ height: heightPx }}
                >
                  <span className="sr-only">
                    {label}: {formatCurrency(bucket.amount)}
                  </span>
                </div>
                {showLabel && (
                  <span aria-hidden="true" className="w-full truncate text-center text-[10px] text-gray-400">
                    {label}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
