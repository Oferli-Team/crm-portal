import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrganizationDetail } from "@/lib/platform-admin/queries/organization-detail";
import { formatFileSize } from "@/lib/format";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { DetailSection, Field } from "@/components/platform-admin/detail-section";

export const metadata: Metadata = {
  title: "Organization — Platform Admin",
};

function formatDate(date: Date | null): string {
  return date ? date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "Not set";
}

function formatLimit(value: number | null): string {
  return value === null ? "Unlimited" : String(value);
}

export default async function PlatformAdminOrganizationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const now = new Date();
  const detail = await getOrganizationDetail(id, now);

  if (!detail) {
    notFound();
  }

  const { organization, businessIdentity, entitlements, portalStatistics } = detail;

  const addressLines = [businessIdentity.streetAddress, businessIdentity.city, businessIdentity.state, businessIdentity.postalCode].filter(
    Boolean,
  );

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/platform-admin/organizations"
          className="rounded text-sm text-gray-500 hover:text-gray-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
        >
          ← Organizations
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">{organization.name}</h1>
          <StatusBadge status={detail.lifecycleStatus} />
        </div>
        <p className="mt-1 text-sm text-gray-500">{organization.slug}</p>
      </div>

      <DetailSection id="business-identity" title="Business Identity">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Display name" value={businessIdentity.displayName} />
          <Field label="Legal name" value={businessIdentity.legalName ?? "Not set"} />
          <Field label="Country" value={businessIdentity.country ?? "Not set"} />
          <Field
            label="Website"
            value={
              businessIdentity.website ? (
                <a
                  href={businessIdentity.website}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="rounded text-black hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
                >
                  {businessIdentity.website}
                </a>
              ) : (
                "Not set"
              )
            }
          />
          <Field label="Support email" value={businessIdentity.supportEmail ?? "Not set"} />
          <Field label="Phone" value={businessIdentity.phone ?? "Not set"} />
          <Field label="Tax ID" value={businessIdentity.taxId ?? "Not set"} />
          <Field label="Address" value={addressLines.length > 0 ? addressLines.join(", ") : "Not set"} />
          <Field
            label="Brand color"
            value={
              businessIdentity.brandColor ? (
                <span className="inline-flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="inline-block h-4 w-4 rounded-full border border-gray-300"
                    style={{ backgroundColor: businessIdentity.brandColor }}
                  />
                  {businessIdentity.brandColor}
                </span>
              ) : (
                "Not set"
              )
            }
          />
          <Field
            label="Logo"
            value={
              businessIdentity.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- mirrors settings/company/page.tsx's own read-only logo display; a remote Supabase Storage URL, not a local asset next/image can optimize.
                <img
                  src={businessIdentity.logoUrl}
                  alt={`${organization.name} logo`}
                  className="mt-1 h-16 w-16 rounded-md border border-gray-200 object-contain"
                />
              ) : (
                "No logo uploaded"
              )
            }
          />
        </dl>
      </DetailSection>

      <DetailSection id="subscription" title="Subscription">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Lifecycle" value={<StatusBadge status={detail.lifecycleStatus} />} />
          <Field label="Access mode" value={<StatusBadge status={entitlements.accessMode} />} />
          <Field label="Trial start" value={formatDate(detail.trialStartedAt)} />
          <Field label="Trial end" value={formatDate(entitlements.trialEndsAt)} />
          <Field label="Current plan" value={detail.planDisplayName} />
        </dl>

        <h3 className="mt-6 text-sm font-semibold text-gray-900">Limits &amp; usage</h3>
        <dl className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Staff seats" value={`${entitlements.currentMembers} / ${formatLimit(entitlements.maxMembers)}`} />
          <Field label="Clients" value={`${entitlements.currentClients} / ${formatLimit(entitlements.maxClients)}`} />
          <Field label="Projects" value={`${entitlements.currentProjects} / ${formatLimit(entitlements.maxProjects)}`} />
          <Field
            label="Storage"
            value={`${formatFileSize(entitlements.currentStorageBytes)} / ${formatFileSize(entitlements.maxStorageBytes)}`}
          />
        </dl>
      </DetailSection>

      <DetailSection id="organization" title="Organization">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Created" value={formatDate(organization.createdAt)} />
          <Field label="Slug" value={organization.slug} />
          <Field
            label="Owner"
            value={
              detail.owner ? (
                <>
                  <div>{detail.owner.name}</div>
                  <div className="text-xs text-gray-500">{detail.owner.email}</div>
                </>
              ) : (
                "No owner"
              )
            }
          />
          <Field label="Staff users" value={detail.staff.length} />
          <Field label="Portal users" value={portalStatistics.portalUsersCount} />
        </dl>
      </DetailSection>

      <DetailSection id="usage" title="Usage">
        <dl className="grid grid-cols-3 gap-4">
          <Field label="Clients" value={detail.clients.total} />
          <Field label="Projects" value={detail.projects.total} />
          <Field label="Tasks" value={detail.tasksTotal} />
        </dl>
      </DetailSection>

      <DetailSection id="recent-activity" title="Recent Activity">
        {detail.recentActivity.length === 0 ? (
          <EmptyState title="No activity yet" description="Activity for this organization will appear here as it happens." />
        ) : (
          <ul className="divide-y divide-gray-100">
            {detail.recentActivity.map((item) => (
              <li key={item.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm text-gray-900">
                    <span className="font-medium">{item.display.actorLabel}</span> {item.display.actionLabel}
                  </p>
                  <time dateTime={item.display.timestamp.toISOString()} className="shrink-0 text-xs text-gray-500">
                    {formatDate(item.display.timestamp)}
                  </time>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
    </div>
  );
}
