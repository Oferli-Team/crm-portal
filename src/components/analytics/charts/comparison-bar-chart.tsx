"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import type { GrowthMetric } from "@/lib/analytics/types";
import { GrowthIndicator } from "../growth-indicator";

/**
 * Analytics Stage 3 ("comparison periods: current period; previous
 * period; percentage change"). Deliberately reuses Stage 1's
 * `GrowthMetric` — already computed by queries/growth-metrics.ts as part
 * of the same service call — rather than a second, separate query; this
 * is purely a different way of *displaying* data the page already has,
 * never a new data fetch.
 */
export function ComparisonBarChart({ label, metric }: { label: string; metric: GrowthMetric }) {
  const data = [
    { period: "Previous period", count: metric.previousPeriodCount },
    { period: "Current period", count: metric.currentPeriodCount },
  ];

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-gray-900">{label}</p>
        <GrowthIndicator metric={metric} label={label} />
      </div>
      <div role="img" aria-label={`${label}: ${metric.previousPeriodCount} previous period, ${metric.currentPeriodCount} current period`} className="mt-2 h-32 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" accessibilityLayer margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
            <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: "#6b7280" }} tickLine={false} axisLine={{ stroke: "#e5e7eb" }} />
            <YAxis type="category" dataKey="period" tick={{ fontSize: 11, fill: "#6b7280" }} tickLine={false} axisLine={false} width={90} />
            <Tooltip cursor={{ fill: "#f9fafb" }} contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e5e7eb" }} />
            <Bar dataKey="count" name={label} fill="#111827" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
