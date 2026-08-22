import type { TimeRange } from "@/lib/analytics/types";
import { AnalyticsRangeSelector } from "./analytics-range-selector";

export function AnalyticsHeader({ selected }: { selected: TimeRange }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Analytics</h1>
        <p className="mt-1 text-sm text-gray-500">Derived entirely from your organization&apos;s own data.</p>
      </div>
      <AnalyticsRangeSelector selected={selected} />
    </div>
  );
}
