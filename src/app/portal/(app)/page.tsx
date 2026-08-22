import Link from "next/link";
import { getCurrentPortalUser } from "@/lib/current-portal-user";
import { getPortalOverview } from "@/lib/client-portal/queries";
import { MetricCard } from "@/components/dashboard/metric-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { PortalWelcomeBanner } from "@/components/portal/portal-welcome-banner";
import { isPortalWelcomeEligible } from "@/components/portal/portal-welcome-eligibility";
import { formatCurrency } from "@/lib/format";

const OVERVIEW_HEADING_ID = "portal-overview-heading";

const itemLinkClass =
  "rounded text-sm font-medium text-gray-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2";
const viewAllClass =
  "rounded text-sm text-gray-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2";

export default async function PortalOverviewPage() {
  const { client, clientId, organizationId, portalUser } = await getCurrentPortalUser();
  const overview = await getPortalOverview(clientId, organizationId);
  const welcomeEligible = isPortalWelcomeEligible(portalUser.createdAt, new Date());

  return (
    <div className="space-y-8">
      <div>
        {/* Stage 6 audit fix: focus-return target for PortalWelcomeBanner's
            "Got it" dismiss — see onboarding-step-row.tsx's own comment on
            why this uses plain `focus:` rather than `focus-visible:`
            (never in the tab order, only ever programmatically focused). */}
        <h1
          id={OVERVIEW_HEADING_ID}
          tabIndex={-1}
          className="rounded text-2xl font-semibold tracking-tight text-gray-900 focus:outline-none focus:ring-2 focus:ring-black focus:ring-offset-2 break-words"
        >
          {client.name}
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          An overview of your projects and invoices.
        </p>
      </div>

      <PortalWelcomeBanner eligible={welcomeEligible} returnFocusId={OVERVIEW_HEADING_ID} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard
          label="Active projects"
          value={overview.activeProjectsCount}
          href="/portal/projects"
        />
        <MetricCard
          label="Open invoices"
          value={overview.openInvoicesCount}
          href="/portal/invoices"
        />
        <MetricCard
          label="Outstanding amount"
          value={formatCurrency(overview.outstandingAmount)}
          href="/portal/invoices?status=open"
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">Recent projects</h2>
            <Link href="/portal/projects" className={viewAllClass}>
              View all
            </Link>
          </div>
          {overview.recentProjects.length === 0 ? (
            <p className="text-sm text-gray-500">No projects yet.</p>
          ) : (
            <ul className="space-y-3">
              {overview.recentProjects.map((project) => (
                <li key={project.id} className="flex items-center justify-between gap-3">
                  <Link href={`/portal/projects/${project.id}`} className={itemLinkClass}>
                    {project.name}
                  </Link>
                  <StatusBadge status={project.status} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">Recent invoices</h2>
            <Link href="/portal/invoices" className={viewAllClass}>
              View all
            </Link>
          </div>
          {overview.recentInvoices.length === 0 ? (
            <p className="text-sm text-gray-500">No invoices yet.</p>
          ) : (
            <ul className="space-y-3">
              {overview.recentInvoices.map((invoice) => (
                <li key={invoice.id} className="flex items-center justify-between gap-3">
                  <Link href={`/portal/invoices/${invoice.id}`} className={itemLinkClass}>
                    {invoice.invoiceNumber}
                  </Link>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-600">
                      {formatCurrency(invoice.amount, invoice.currency)}
                    </span>
                    <StatusBadge status={invoice.status} />
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
