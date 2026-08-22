import { formatStatusLabel } from "@/lib/format";
import { STATUS_TONES, type StatusTone } from "@/components/ui/status-badge";

// Static class strings only — Tailwind can't see a dynamically-built
// `bg-${color}-500`, so every value here is written out in full and never
// concatenated at runtime.
const TONE_BAR_CLASSES: Record<StatusTone, string> = {
  neutral: "bg-gray-400",
  info: "bg-blue-500",
  warning: "bg-amber-500",
  success: "bg-green-500",
  danger: "bg-red-500",
  muted: "bg-gray-300",
};

export type BreakdownItem = { status: string; count: number };

/**
 * Horizontal bars, one per status. Color is purely decorative — the status
 * name, count, and percentage are always rendered as text next to it, so
 * nothing here depends on color alone to be understood.
 */
export function BreakdownCard({
  title,
  items,
  labelFormatter = formatStatusLabel,
}: {
  title: string;
  items: BreakdownItem[];
  labelFormatter?: (status: string) => string;
}) {
  const total = items.reduce((sum, item) => sum + item.count, 0);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>

      {total === 0 ? (
        <p className="mt-4 text-sm text-gray-500">No data yet.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {items.map((item) => {
            const percent = total > 0 ? Math.round((item.count / total) * 100) : 0;
            const tone = STATUS_TONES[item.status] ?? "neutral";
            return (
              <li key={item.status}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-gray-700">{labelFormatter(item.status)}</span>
                  <span className="text-gray-500">
                    {item.count} ({percent}%)
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                  <div
                    className={`h-full rounded-full ${TONE_BAR_CLASSES[tone]}`}
                    style={{ width: `${percent}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
