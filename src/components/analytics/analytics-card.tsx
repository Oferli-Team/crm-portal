import type { ReactNode } from "react";

/**
 * Foundation display: a label, a value, an optional trailing indicator
 * (growth-indicator.tsx), and — since Stage 3 — an optional decorative
 * `sparkline` slot (charts/sparkline.tsx). `value` is always a
 * pre-formatted string/number the caller already resolved (a plan's real
 * `displayName`, a rounded percent, a plain count) — this component never
 * formats an enum or looks up a label itself, so it can never be the
 * place a raw internal value (a `SubscriptionStatus` string, a `PlanKey`,
 * an organization id) leaks into the DOM by accident.
 */
export function AnalyticsCard({
  label,
  value,
  indicator,
  sparkline,
}: {
  label: string;
  value: ReactNode;
  indicator?: ReactNode;
  sparkline?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="text-sm text-gray-500">{label}</p>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <p className="text-2xl font-semibold tracking-tight text-gray-900">{value}</p>
        {indicator}
      </div>
      {sparkline}
    </div>
  );
}
