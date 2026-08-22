import Link from "next/link";
import { ALL_TIME_RANGES, type TimeRange } from "@/lib/analytics/types";
import { TIME_RANGE_LABELS } from "@/lib/analytics/constants";

/**
 * Analytics Stage 2 (docs/analytics-architecture.md §4/§9). Plain `<Link>`
 * elements to `/analytics?range=<value>` — no client-side state, no
 * `"use client"`. This is deliberate, not just simplicity: real anchors
 * are keyboard-reachable and screen-reader-navigable with zero extra
 * work, they survive a refresh for free (the URL *is* the state — the
 * task's own explicit "prefer URL search parameters, do not introduce
 * cookies" requirement), and they degrade to a normal full-page
 * navigation with JS disabled instead of doing nothing.
 */
export function AnalyticsRangeSelector({ selected }: { selected: TimeRange }) {
  return (
    <nav aria-label="Time range" className="flex flex-wrap gap-1">
      {ALL_TIME_RANGES.map((range) => {
        const isSelected = range === selected;
        return (
          <Link
            key={range}
            href={`/analytics?range=${range}`}
            aria-current={isSelected ? "true" : undefined}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 ${
              isSelected ? "bg-black text-white" : "text-gray-700 hover:bg-gray-100"
            }`}
          >
            {TIME_RANGE_LABELS[range]}
          </Link>
        );
      })}
    </nav>
  );
}
