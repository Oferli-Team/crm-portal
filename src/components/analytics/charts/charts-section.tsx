import type { ReactNode } from "react";

/**
 * Analytics Stage 3. Same section/heading shell as AnalyticsGrid, sized
 * for chart panels instead of stat cards — one or two columns depending
 * on how many charts are passed, so a single full-width chart (e.g.
 * Organization Activity) never gets squeezed into a half-width column
 * next to nothing.
 */
export function ChartsSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-heading`} className="rounded-lg border border-gray-200 bg-white p-5">
      <h2 id={`${id}-heading`} className="text-base font-semibold text-gray-900">
        {title}
      </h2>
      <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-2">{children}</div>
    </section>
  );
}

export function ChartPanel({ title, chart }: { title: string; chart: ReactNode }) {
  return (
    <div>
      <p className="text-sm font-medium text-gray-900">{title}</p>
      <div className="mt-2">{chart}</div>
    </div>
  );
}
