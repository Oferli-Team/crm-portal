/**
 * Library-free progress bar (Stage 3 task §8/§18 — no third-party charting
 * package, only existing Tailwind utilities). `role="progressbar"` +
 * `aria-valuenow`/min/max makes the percent available to assistive tech
 * without relying on the adjacent visible text alone.
 */
export function OnboardingProgressBar({
  completedCount,
  totalCount,
  percent,
}: {
  completedCount: number;
  totalCount: number;
  percent: number;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-gray-900">
          {completedCount} of {totalCount} complete
        </span>
        <span className="text-gray-600">{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${completedCount} of ${totalCount} complete`}
        aria-label="Onboarding progress"
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-100"
      >
        <div
          className="h-full rounded-full bg-black transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
