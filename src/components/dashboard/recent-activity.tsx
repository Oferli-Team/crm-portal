import Link from "next/link";
import type { ActivityDisplayModel } from "@/lib/activity/format-activity";

/**
 * Compact preview of the Activity Timeline — reuses formatActivity()'s
 * already-computed display model (actorLabel/actionLabel/isDeleted/etc.)
 * as-is, no separate formatting logic. Deliberately not the full Timeline
 * UI: no day-grouping, no filters, no pagination — just the latest few
 * events with a link to the real page for anything more.
 */
export function RecentActivity({ items }: { items: { id: string; display: ActivityDisplayModel }[] }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Recent activity</h3>
        <Link
          href="/activity"
          className="rounded text-sm text-gray-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
        >
          View all activity
        </Link>
      </div>

      {items.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">No activity yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-gray-100">
          {items.map((item) => (
            <li key={item.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm text-gray-900">
                  <span className="font-medium">{item.display.actorLabel}</span> {item.display.actionLabel}
                  {item.display.isDeleted && (
                    <span className="ml-2 inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                      Deleted
                    </span>
                  )}
                </p>
                <time
                  dateTime={item.display.timestamp.toISOString()}
                  className="shrink-0 text-xs text-gray-400"
                >
                  {item.display.timestamp.toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </time>
              </div>
              {item.display.detailLines.map((line, index) => (
                <p key={index} className="mt-0.5 text-xs text-gray-500">
                  {line}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
