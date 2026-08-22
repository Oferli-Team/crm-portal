import Link from "next/link";
import { DASHBOARD_PERIOD_OPTIONS, type DashboardPeriod } from "@/lib/dashboard/period";

/**
 * Plain server-rendered links, not a <select>/client component — there are
 * only 4 options and no other query params to preserve, so a real
 * navigation per option is simpler and needs no JS to work at all.
 */
export function PeriodSelector({ period }: { period: DashboardPeriod }) {
  return (
    <div>
      <span id="dashboard-period-label" className="block text-xs font-medium text-gray-500">
        Period
      </span>
      <div
        role="group"
        aria-labelledby="dashboard-period-label"
        className="mt-1 flex flex-wrap gap-1 rounded-lg border border-gray-200 bg-white p-1"
      >
        {DASHBOARD_PERIOD_OPTIONS.map((option) => {
          const isActive = option.value === period;
          return (
            <Link
              key={option.value}
              href={option.value === "30d" ? "/dashboard" : `/dashboard?period=${option.value}`}
              aria-current={isActive ? "true" : undefined}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 ${
                isActive ? "bg-black text-white" : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              {option.label}
            </Link>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-gray-500">
        Only Paid revenue and Revenue over time change with this — everything else always reflects the
        current state.
      </p>
    </div>
  );
}
