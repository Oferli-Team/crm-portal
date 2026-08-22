"use client";

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { formatBucketLabel } from "@/lib/analytics/calculations/format-bucket-label";
import type { ChartSeries } from "@/lib/analytics/types";
import { ChartEmptyState } from "./chart-empty-state";

/**
 * Analytics Stage 3. Client Component (Recharts needs the DOM/canvas —
 * see docs/analytics-architecture.md §11 for why this file, and every
 * other file in this directory, starts with `"use client"`) fed
 * already-aggregated data computed entirely server-side
 * (queries/time-series.ts) — this component only ever formats and draws
 * points it's given, never fetches, sums, or buckets anything itself.
 *
 * `accessibilityLayer` (Recharts' own built-in keyboard/screen-reader
 * support: Tab focuses the chart, arrow keys move between data points,
 * each point is announced) is the reason this library was chosen over
 * lower-level alternatives that would need that built by hand — see the
 * architecture doc's own "Library selection" section.
 */
export function GrowthLineChart({ label, series, color = "#111827" }: { label: string; series: ChartSeries; color?: string }) {
  const total = series.points.reduce((sum, p) => sum + p.count, 0);
  if (total === 0) {
    return <ChartEmptyState label={label} />;
  }

  const data = series.points.map((p) => ({
    label: formatBucketLabel(p.bucketStart, series.unit),
    count: p.count,
  }));

  return (
    <div role="img" aria-label={`${label} over time, ${total} total`} className="h-48 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} accessibilityLayer margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 12, fill: "#6b7280" }} tickLine={false} axisLine={{ stroke: "#e5e7eb" }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: "#6b7280" }} tickLine={false} axisLine={false} width={28} />
          <Tooltip cursor={{ stroke: "#e5e7eb" }} contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e5e7eb" }} />
          <Line type="monotone" dataKey="count" name={label} stroke={color} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
