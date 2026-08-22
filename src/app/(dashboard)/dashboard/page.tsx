import Link from "next/link";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { formatCurrency } from "@/lib/format";
import { MetricCard } from "@/components/dashboard/metric-card";
import { PeriodSelector } from "@/components/dashboard/period-selector";
import { RevenueChart } from "@/components/dashboard/revenue-chart";
import { BreakdownCard } from "@/components/dashboard/breakdown-card";
import { RecentActivity } from "@/components/dashboard/recent-activity";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatInvoiceStatusLabel } from "@/lib/invoices/status-label";
import { OnboardingCard, ONBOARDING_DISMISS_RETURN_FOCUS_ID } from "@/components/onboarding/onboarding-card";
import { parseDashboardPeriod, formatDashboardPeriodLabel } from "@/lib/dashboard/period";
import { getOrganizationOnboardingProgress } from "@/lib/onboarding/progress";
import { getDashboardAnalytics } from "./query";
import type { RawSearchParams } from "@/lib/list-params";

const linkClass =
  "rounded text-sm text-gray-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2";
const itemLinkClass =
  "rounded text-sm font-medium text-gray-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  // organizationId always comes from the session/cookie, never from
  // searchParams — only `period` is ever read from the query string, and
  // it's validated (with a safe fallback) before being used for anything.
  const { organizationId } = await getCurrentUserOrganization();
  const resolvedSearchParams = await searchParams;
  const period = parseDashboardPeriod(resolvedSearchParams.period);
  const now = new Date();

  const [analytics, onboardingProgress] = await Promise.all([
    getDashboardAnalytics({ organizationId, period, now }),
    getOrganizationOnboardingProgress(organizationId),
  ]);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          {/* Stage 6 audit fix: focus-return target for
              DismissOnboardingButton — see onboarding-step-row.tsx's own
              comment on why this uses plain `focus:` rather than
              `focus-visible:` (never in the tab order, only ever
              programmatically focused). */}
          <h1
            id={ONBOARDING_DISMISS_RETURN_FOCUS_ID}
            tabIndex={-1}
            className="rounded text-2xl font-semibold tracking-tight text-gray-900 focus:outline-none focus:ring-2 focus:ring-black focus:ring-offset-2"
          >
            Dashboard
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            An overview of your clients, projects, tasks, and invoices.
          </p>
        </div>
        <PeriodSelector period={period} />
      </div>

      <OnboardingCard progress={onboardingProgress} />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <MetricCard label="Total clients" value={analytics.kpis.totalClients} href="/clients" />
        <MetricCard
          label="Active projects"
          value={analytics.kpis.activeProjects}
          href="/projects"
        />
        <MetricCard label="Open tasks" value={analytics.kpis.openTasks} href="/tasks" />
        <MetricCard
          label="Overdue tasks"
          value={analytics.kpis.overdueTasksCount}
          href="/tasks"
        />
        <MetricCard
          label="Outstanding amount"
          value={formatCurrency(analytics.kpis.outstandingAmount)}
          href="/invoices"
        />
        <MetricCard
          label="Paid revenue"
          value={formatCurrency(analytics.kpis.paidRevenue)}
          href="/invoices"
          hint={formatDashboardPeriodLabel(period)}
        />
      </div>

      <RevenueChart
        buckets={analytics.revenue.buckets}
        bucketUnit={analytics.periodRange.bucketUnit}
        total={analytics.revenue.total}
        period={period}
      />

      <div>
        <h2 className="text-lg font-semibold tracking-tight text-gray-900">Breakdowns</h2>
        <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <BreakdownCard title="Invoice status" items={analytics.breakdowns.invoiceStatus} labelFormatter={formatInvoiceStatusLabel} />
          <BreakdownCard title="Task status" items={analytics.breakdowns.taskStatus} />
          <BreakdownCard title="Project status" items={analytics.breakdowns.projectStatus} />
        </div>
      </div>

      <RecentActivity items={analytics.recentActivity} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">Upcoming tasks</h3>
            <Link href="/tasks" className={linkClass}>
              View all
            </Link>
          </div>
          {analytics.upcomingTasks.length === 0 ? (
            <p className="text-sm text-gray-500">No upcoming tasks.</p>
          ) : (
            <ul className="divide-y divide-gray-200">
              {analytics.upcomingTasks.map((task) => (
                <li key={task.id} className="py-3 first:pt-0 last:pb-0">
                  <Link href={`/tasks/${task.id}/edit`} className={itemLinkClass}>
                    {task.title}
                  </Link>
                  <p className="text-sm text-gray-500">{task.projectName}</p>
                  <p className="mt-1 text-xs text-gray-500">
                    Due {task.dueDate.toLocaleDateString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <h3 className="mb-4 text-sm font-semibold text-gray-900">Overdue items</h3>
          {analytics.overdueItems.length === 0 ? (
            <p className="text-sm text-gray-500">Nothing overdue.</p>
          ) : (
            <ul className="divide-y divide-gray-200">
              {analytics.overdueItems.map((item) => (
                <li key={`${item.kind}-${item.id}`} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                      {item.kind === "task" ? "Task" : "Invoice"}
                    </span>
                    <Link
                      href={item.kind === "task" ? `/tasks/${item.id}/edit` : `/invoices/${item.id}/edit`}
                      className={itemLinkClass}
                    >
                      {item.kind === "task" ? item.title : item.invoiceNumber}
                    </Link>
                  </div>
                  <p className="mt-1 text-sm text-gray-500">
                    {item.kind === "task" ? item.projectName : item.clientName}
                    {item.kind === "invoice" && ` · ${formatCurrency(item.amount, item.currency)}`}
                  </p>
                  <p className="mt-0.5 text-xs text-red-600">
                    Due {item.dueDate.toLocaleDateString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">Recent invoices</h3>
            <Link href="/invoices" className={linkClass}>
              View all
            </Link>
          </div>
          {analytics.recentInvoices.length === 0 ? (
            <p className="text-sm text-gray-500">No invoices yet.</p>
          ) : (
            <ul className="divide-y divide-gray-200">
              {analytics.recentInvoices.map((invoice) => (
                <li key={invoice.id} className="py-3 first:pt-0 last:pb-0">
                  <Link href={`/invoices/${invoice.id}/edit`} className={itemLinkClass}>
                    {invoice.invoiceNumber}
                  </Link>
                  <p className="text-sm text-gray-500">{invoice.clientName}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <StatusBadge status={invoice.status} label={formatInvoiceStatusLabel(invoice.status)} />
                    <span className="text-xs text-gray-500">
                      {formatCurrency(invoice.amount, invoice.currency)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
