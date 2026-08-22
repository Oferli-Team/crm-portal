import { getCurrentMembership } from "@/lib/current-user";
import { getOrganizationAnalytics } from "@/lib/analytics/services/analytics-service";
import { AnalyticsAccessError } from "@/lib/analytics/authorization";
import { parseTimeRangeParam } from "@/lib/analytics/constants";
import { getPlan } from "@/lib/billing/plans";
import { StatusBadge } from "@/components/ui/status-badge";
import { AnalyticsHeader } from "@/components/analytics/analytics-header";
import { AnalyticsGrid } from "@/components/analytics/analytics-grid";
import { AnalyticsEmptyState } from "@/components/analytics/analytics-empty-state";
import { AnalyticsAccessDenied } from "@/components/analytics/analytics-access-denied";
import { GrowthIndicator } from "@/components/analytics/growth-indicator";
import { Sparkline } from "@/components/analytics/charts/sparkline";
import { GrowthLineChart } from "@/components/analytics/charts/growth-line-chart";
import { ActivityStackedBarChart } from "@/components/analytics/charts/activity-stacked-bar-chart";
import { ComparisonBarChart } from "@/components/analytics/charts/comparison-bar-chart";
import { ChartsSection, ChartPanel } from "@/components/analytics/charts/charts-section";
import { OrganizationActivitySection } from "@/components/analytics/charts/organization-activity-section";
import { PortalAnalyticsSection } from "@/components/analytics/charts/portal-analytics-section";

/**
 * Analytics Stage 3 (docs/analytics-architecture.md §10/§11). Authorization
 * is enforced entirely server-side by `getOrganizationAnalytics()` itself
 * (it calls `assertCanViewAnalytics()` before running any query) — this
 * page never re-implements that check, it only decides how to *render*
 * the already-server-made decision. `AnalyticsAccessError` is caught
 * here, server-side, via `instanceof` (safe: this catch runs in the same
 * process as the throw, never crosses a serialization boundary) and
 * rendered as a dedicated "Access denied" state — deliberately NOT
 * delegated to this route's `error.tsx`, since Next.js redacts Server
 * Component error messages by default in production before they'd ever
 * reach a client-side error boundary. Every other thrown error still
 * propagates to `error.tsx` normally. Client Portal identities never
 * reach this page at all: it lives under `(dashboard)`, whose layout
 * already redirects any Portal-only identity to `/portal` first.
 *
 * `range` is read from the URL (`?range=`), never a cookie; every chart
 * below is fed exclusively from `data.charts`, computed in the same
 * single `getOrganizationAnalytics()` call as every KPI card — no second
 * service call anywhere on this page, and no aggregation happens
 * client-side: charts only ever format and draw numbers this page
 * already has.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { organizationId, membership } = await getCurrentMembership();
  const { range: rawRange } = await searchParams;
  const timeRange = parseTimeRangeParam(rawRange);

  let data;
  try {
    data = await getOrganizationAnalytics(organizationId, membership.role, timeRange);
  } catch (err) {
    if (err instanceof AnalyticsAccessError) {
      return <AnalyticsAccessDenied />;
    }
    throw err;
  }

  const isOverviewEmpty =
    data.organization.totalClients === 0 &&
    data.organization.totalProjects === 0 &&
    data.organization.totalTasks === 0 &&
    data.organization.totalInvoices === 0 &&
    data.organization.totalAttachments === 0;

  const plan = getPlan(data.billing.planKey);

  // Pure reshaping of already-fetched series (no new query, no
  // aggregation) — sparklines only need one number per bucket, not the
  // separate created/completed split the full charts below use.
  const taskCreatedSeries = { unit: data.charts.taskActivitySeries.unit, points: data.charts.taskActivitySeries.points.map((p) => ({ bucketStart: p.bucketStart, count: p.created })) };
  const invoiceCreatedSeries = { unit: data.charts.invoiceActivitySeries.unit, points: data.charts.invoiceActivitySeries.points.map((p) => ({ bucketStart: p.bucketStart, count: p.created })) };

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <AnalyticsHeader selected={data.timeRange} />

      <div className="mt-6 space-y-6">
        {isOverviewEmpty ? (
          <AnalyticsEmptyState />
        ) : (
          <AnalyticsGrid
            id="analytics-overview"
            title="Overview"
            metrics={[
              { label: "Clients", value: data.organization.totalClients, sparkline: <Sparkline series={data.charts.clientGrowthSeries} /> },
              { label: "Projects", value: data.organization.totalProjects, sparkline: <Sparkline series={data.charts.projectGrowthSeries} /> },
              { label: "Tasks", value: data.organization.totalTasks, sparkline: <Sparkline series={taskCreatedSeries} /> },
              { label: "Completed tasks", value: data.organization.completedTasks },
              { label: "Invoices", value: data.organization.totalInvoices, sparkline: <Sparkline series={invoiceCreatedSeries} /> },
              { label: "Members", value: data.organization.totalMembers },
              { label: "Attachments", value: data.organization.totalAttachments },
            ]}
          />
        )}

        <AnalyticsGrid
          id="analytics-activity"
          title="Activity"
          metrics={[
            { label: "Today", value: data.activity.createdToday },
            { label: "This week", value: data.activity.createdThisWeek },
            { label: "This month", value: data.activity.createdThisMonth },
          ]}
        />

        <AnalyticsGrid
          id="analytics-completion"
          title="Completion"
          metrics={[
            { label: "Task completion rate", value: `${data.completion.taskCompletionRate}%` },
            { label: "Invoice completion rate", value: `${data.completion.invoiceCompletionRate}%` },
          ]}
        />

        <AnalyticsGrid
          id="analytics-growth"
          title="Growth"
          metrics={[
            {
              label: "Clients",
              value: data.growth.clientGrowth.currentPeriodCount,
              indicator: <GrowthIndicator metric={data.growth.clientGrowth} label="Client growth" />,
            },
            {
              label: "Projects",
              value: data.growth.projectGrowth.currentPeriodCount,
              indicator: <GrowthIndicator metric={data.growth.projectGrowth} label="Project growth" />,
            },
            {
              label: "Tasks",
              value: data.growth.taskGrowth.currentPeriodCount,
              indicator: <GrowthIndicator metric={data.growth.taskGrowth} label="Task growth" />,
            },
          ]}
        />

        <ChartsSection id="analytics-trends" title="Trends">
          <ChartPanel title="Client growth" chart={<GrowthLineChart label="Clients" series={data.charts.clientGrowthSeries} />} />
          <ChartPanel title="Project growth" chart={<GrowthLineChart label="Projects" series={data.charts.projectGrowthSeries} />} />
        </ChartsSection>

        <ChartsSection id="analytics-task-invoice-activity" title="Task &amp; invoice activity">
          <ChartPanel title="Tasks: created vs. completed" chart={<ActivityStackedBarChart label="Tasks" series={data.charts.taskActivitySeries} />} />
          <ChartPanel title="Invoices: created vs. paid" chart={<ActivityStackedBarChart label="Invoices" series={data.charts.invoiceActivitySeries} />} />
        </ChartsSection>

        <section aria-labelledby="analytics-comparison-heading" className="rounded-lg border border-gray-200 bg-white p-5">
          <h2 id="analytics-comparison-heading" className="text-base font-semibold text-gray-900">
            Period comparison
          </h2>
          <div className="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-3">
            <ComparisonBarChart label="Clients" metric={data.growth.clientGrowth} />
            <ComparisonBarChart label="Projects" metric={data.growth.projectGrowth} />
            <ComparisonBarChart label="Tasks" metric={data.growth.taskGrowth} />
          </div>
        </section>

        <OrganizationActivitySection
          activityEventsSeries={data.charts.activityEventsSeries}
          onboarding={data.onboarding}
          subscriptionEventCount={data.billing.subscriptionEventCount}
        />

        <PortalAnalyticsSection
          portal={data.portal}
          portalUserGrowthSeries={data.charts.portalUserGrowthSeries}
          portalInvitationSeries={data.charts.portalInvitationSeries}
        />

        <AnalyticsGrid
          id="analytics-status"
          title="Status"
          metrics={[
            { label: "Plan", value: plan.displayName },
            { label: "Subscription status", value: <StatusBadge status={data.billing.subscriptionStatus} /> },
            { label: "Onboarding progress", value: `${data.onboarding.percent}%` },
          ]}
        />
      </div>
    </div>
  );
}
