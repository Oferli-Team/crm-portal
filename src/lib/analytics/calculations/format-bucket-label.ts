import type { BucketUnit } from "../types";

/**
 * Analytics Stage 3. Pure, UTC-based (matches every other date
 * calculation in this domain — see date-ranges.ts's own UTC-only rule).
 * Purely presentational — chart components call this to label the x-axis;
 * it never affects what data is fetched or how it's aggregated (that's
 * still 100% server-side, in queries/time-series.ts).
 */
export function formatBucketLabel(bucketStart: Date, unit: BucketUnit): string {
  if (unit === "hour") {
    const hours = bucketStart.getUTCHours();
    const period = hours >= 12 ? "PM" : "AM";
    const hour12 = hours % 12 === 0 ? 12 : hours % 12;
    return `${hour12} ${period}`;
  }

  const month = bucketStart.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = bucketStart.getUTCDate();
  return `${month} ${day}`;
}
