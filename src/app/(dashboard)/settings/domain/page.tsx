import { getCurrentUserOrganization, getCurrentMembership } from "@/lib/current-user";
import { prisma } from "@/lib/prisma";
import { getDomainSettings, getGeneratedSubdomain } from "@/lib/organization-setup/domain-settings";
import { canManageDomainSettings } from "@/lib/organization-setup/authorization";
import { StatusBadge } from "@/components/ui/status-badge";
import { DomainSettingsForm } from "./domain-settings-form";

/**
 * Customer Setup Wizard (Stage 6.2). Every member may view (same "read
 * open, write OWNER-only" boundary as Company Profile) — the generated
 * subdomain and any configured custom domain are unremarkable, already
 * effectively public facts (the slug they're derived from is already
 * visible in the org switcher). No DNS/domain verification of any kind
 * happens here — verificationStatus is a fixed, inert placeholder (see
 * its own schema comment). Staff-only by construction, same as every
 * other page under (dashboard).
 */
export default async function DomainSettingsPage() {
  const { organizationId } = await getCurrentUserOrganization();
  const { membership } = await getCurrentMembership();
  const organization = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { slug: true } });
  const settings = await getDomainSettings(organizationId);
  const generatedSubdomain = getGeneratedSubdomain(organization.slug);
  const canManage = canManageDomainSettings(membership.role);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Domain settings</h1>
      <p className="mt-1 text-sm text-gray-500">
        Your workspace&apos;s address, and an optional custom domain for later.
      </p>

      <div className="mt-6 space-y-1 rounded-lg border border-gray-200 bg-white p-6">
        <p className="text-xs font-medium text-gray-500">Generated subdomain</p>
        <p className="font-mono text-sm text-gray-900">{generatedSubdomain}</p>
      </div>

      {canManage ? (
        <DomainSettingsForm settings={settings} />
      ) : (
        <div className="mt-6 rounded-lg border border-gray-200 bg-white p-6">
          <p className="text-sm text-gray-600">Only the organization owner can update domain settings.</p>
          <dl className="mt-4">
            <dt className="text-xs font-medium text-gray-500">Custom domain</dt>
            <dd className="mt-1 flex items-center gap-2 text-sm text-gray-900">
              {settings.customDomain ? (
                <>
                  <span>{settings.customDomain}</span>
                  {settings.verificationStatus && <StatusBadge status={settings.verificationStatus} />}
                </>
              ) : (
                "Not configured"
              )}
            </dd>
          </dl>
        </div>
      )}
    </div>
  );
}
