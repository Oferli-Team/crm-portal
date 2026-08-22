/**
 * Analytics Stage 3. Shown by an individual chart when its own series has
 * zero activity across every bucket in the window — distinct from
 * analytics-empty-state.tsx (Stage 2), which replaces the whole Overview
 * section only when an organization has no data at all. This one covers
 * the narrower case: a single dimension (e.g. Projects) with real
 * activity elsewhere on the page but nothing in the selected range.
 */
export function ChartEmptyState({ label }: { label: string }) {
  return (
    <div className="flex h-48 w-full flex-col items-center justify-center rounded-md border border-dashed border-gray-200 text-center">
      <p className="text-sm text-gray-400">Not enough data yet for {label.toLowerCase()}.</p>
    </div>
  );
}
