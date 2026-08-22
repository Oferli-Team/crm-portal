import { OnboardingProgressBar } from "@/components/onboarding/onboarding-progress-bar";
import type { ChartSeries, OnboardingMetrics } from "@/lib/analytics/types";
import { GrowthLineChart } from "./growth-line-chart";

/**
 * Analytics Stage 3 ("Organization activity: Activity events; onboarding
 * progress; subscription status transitions — aggregate only"). Three
 * distinct signals in one section:
 *
 * - Activity events — a real chart (GrowthLineChart), same component
 *   every other single-series chart on this page uses.
 * - Onboarding progress — deliberately reuses
 *   src/components/onboarding/onboarding-progress-bar.tsx unmodified
 *   (read-only reuse, same rule Stage 1 already established for
 *   queries/onboarding-metrics.ts) rather than building a second progress
 *   bar; an organization with no OrganizationOnboardingStep rows at all
 *   (never onboarded, or pre-Onboarding-stage) still renders a real,
 *   correct 0%-or-higher bar — `getOrganizationOnboardingProgress()`
 *   already has no error path for that case.
 * - Subscription status transitions — a single aggregate number
 *   (`subscriptionEventCount`), deliberately NOT a chart: the task's own
 *   "aggregate only" instruction, and queries/billing-metrics.ts's own
 *   `getSubscriptionEventCount` never reads anything about an individual
 *   event.
 */
export function OrganizationActivitySection({
  activityEventsSeries,
  onboarding,
  subscriptionEventCount,
}: {
  activityEventsSeries: ChartSeries;
  onboarding: OnboardingMetrics;
  subscriptionEventCount: number;
}) {
  return (
    <section aria-labelledby="analytics-org-activity-heading" className="rounded-lg border border-gray-200 bg-white p-5">
      <h2 id="analytics-org-activity-heading" className="text-base font-semibold text-gray-900">
        Organization activity
      </h2>

      <div className="mt-4">
        <p className="text-sm font-medium text-gray-900">Activity events</p>
        <div className="mt-2">
          <GrowthLineChart label="Activity events" series={activityEventsSeries} />
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div>
          <p className="text-sm font-medium text-gray-900">Onboarding progress</p>
          <div className="mt-2">
            <OnboardingProgressBar
              completedCount={onboarding.completedCount}
              totalCount={onboarding.totalCount}
              percent={onboarding.percent}
            />
          </div>
        </div>

        <div>
          <p className="text-sm font-medium text-gray-900">Subscription events</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-gray-900">{subscriptionEventCount}</p>
          <p className="mt-1 text-xs text-gray-500">Processed status transitions, all time.</p>
        </div>
      </div>
    </section>
  );
}
