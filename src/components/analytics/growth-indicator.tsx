import type { GrowthMetric } from "@/lib/analytics/types";

/**
 * Analytics Stage 2. Text-only direction indicator — no sparkline/chart
 * (still explicitly out of scope). Three real states (positive/negative/
 * neutral, i.e. exactly 0%) plus one "no data" state — `null`
 * (`previousPeriodCount` was 0) is never rendered as `0%`/hidden/`∞%`,
 * so a brand-new organization's growth row is never misread as "flat."
 * Color is never the only signal: the leading `+`/`−`/`±0` glyph and the
 * `aria-label` both carry the same information text alone would.
 */
export function GrowthIndicator({ metric, label }: { metric: GrowthMetric; label: string }) {
  if (metric.changePercent === null) {
    return (
      <span className="text-xs text-gray-400" aria-label={`${label}: no prior-period data`}>
        No prior data
      </span>
    );
  }

  const isPositive = metric.changePercent > 0;
  const isNegative = metric.changePercent < 0;
  const tone = isPositive ? "text-green-700" : isNegative ? "text-red-700" : "text-gray-500";
  const glyph = isPositive ? "+" : isNegative ? "−" : "±";
  const magnitude = Math.abs(metric.changePercent);
  const direction = isPositive ? "up" : isNegative ? "down" : "unchanged";

  return (
    <span
      className={`text-xs font-medium ${tone}`}
      aria-label={`${label}: ${direction} ${magnitude}% compared with the previous period`}
    >
      {glyph}
      {magnitude}%
    </span>
  );
}
