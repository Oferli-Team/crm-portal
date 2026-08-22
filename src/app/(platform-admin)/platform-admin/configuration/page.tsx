import type { Metadata } from "next";
import {
  getPlatformBranding,
  getPlatformDeploymentConfig,
  getPlatformDomainConfig,
  getPlatformEmailConfig,
  getPlatformLegalConfig,
} from "@/lib/legal/platform-config";
import { getPlatformBillingConfig } from "@/lib/billing/platform-billing-config";
import { DetailSection, Field } from "@/components/platform-admin/detail-section";

export const metadata: Metadata = {
  title: "Configuration — Platform Admin",
};

/** A syntactically well-formed absolute URL — nothing more. The preview is a rendering-safety check (an unparseable value would otherwise be a broken <img> with no explanation), not a business validation rule, so it lives here rather than in platform-config.ts. */
function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sale-Ready Phase D, D1 (foundation) + D2 (Branding) + D3 (Email
 * Configuration) + D4 (Billing Configuration) + D5 (Domain
 * Configuration) + D6 (Deployment Information + Environment
 * Information — the final Phase D PR). Read-only for this phase,
 * deliberately — see the plan's own framing: this is a Phase D scoping
 * decision, not a claim that env-var-only configuration is this
 * module's permanent shape. Every section's data comes from one small,
 * typed reader (getPlatformBranding()/getPlatformEmailConfig()/
 * getPlatformLegalConfig()/getPlatformDomainConfig()/
 * getPlatformDeploymentConfig() in platform-config.ts,
 * getPlatformBillingConfig() in src/lib/billing — the latter
 * deliberately lives in the billing domain, not platform-config.ts, so
 * it can reuse the existing billing provider abstraction directly
 * rather than a second, parallel read of the same facts) returning a
 * plain object the page renders via DetailSection/Field — never
 * process.env or a provider adapter read inline — so a future editable
 * Platform Configuration service can change what's *behind* each
 * reader without this page changing at all.
 *
 * Environment Information (below) is a pure rollup, not a new source of
 * truth — every "Set"/"Configured" row is derived straight from the
 * branding/email/billing/domain/legal objects this component already
 * computed for the sections above, never a second, independent
 * process.env read that could drift from what each section already
 * shows.
 */
export default async function PlatformAdminConfigurationPage() {
  const branding = getPlatformBranding();
  const email = getPlatformEmailConfig();
  const billing = await getPlatformBillingConfig();
  const domain = getPlatformDomainConfig();
  const legal = getPlatformLegalConfig();
  const deployment = getPlatformDeploymentConfig();
  const logoPreviewUrl = branding.logoUrl && isValidUrl(branding.logoUrl) ? branding.logoUrl : null;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Configuration</h1>
        <p className="mt-1 text-sm text-gray-600">
          Platform-wide settings for the operator of this Service — separate from any organization&rsquo;s own
          settings.
        </p>
      </div>

      <DetailSection id="branding" title="Branding">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Platform name" value={branding.name} />
          <Field label="Platform tagline" value={branding.tagline} />
          <Field label="Platform logo URL" value={branding.logoUrl ?? "Not set"} />
          <Field label="Favicon URL" value={branding.faviconUrl ?? "Not set"} />
          <Field
            label="Platform logo preview"
            value={
              logoPreviewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- mirrors Organization Details' own read-only logo preview; an operator-supplied remote URL, not a local asset next/image can optimize.
                <img
                  src={logoPreviewUrl}
                  alt={`${branding.name} logo`}
                  className="h-16 w-16 rounded-md border border-gray-200 object-contain"
                />
              ) : (
                "Not set"
              )
            }
          />
        </dl>
      </DetailSection>

      <DetailSection id="email" title="Email Configuration">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Support email" value={email.supportEmail ?? "Not set"} />
          <Field label="Billing email" value={email.billingEmail ?? "Not set"} />
          <Field label="Sender email" value={email.senderEmail ?? "Not set"} />
          <Field label="Reply-to email" value={email.replyToEmail ?? "Not set"} />
        </dl>

        <h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-gray-500">Status</h3>
        <dl className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Email provider" value={email.providerName} />
          <Field label="Provider status" value={email.providerConfigured ? "Configured" : "Not configured"} />
          <Field label="Sender status" value={email.senderConfigured ? "Configured" : "Missing"} />
          <Field label="Reply-to status" value={email.replyToConfigured ? "Configured" : "Fallback"} />
        </dl>
      </DetailSection>

      <DetailSection id="billing" title="Billing Configuration">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Billing provider" value={billing.providerName} />
          <Field label="Provider status" value={billing.providerConfigured ? "Configured" : "Not configured"} />
          <Field label="Mode" value={billing.mode} />
          <Field label="Checkout" value={billing.checkoutConfigured ? "Configured" : "Not configured"} />
          <Field label="Customer portal" value={billing.customerPortalConfigured ? "Configured" : "Not configured"} />
          <Field label="Webhook" value={billing.webhookConfigured ? "Configured" : "Not configured"} />
          <Field label="Plan synchronization" value={billing.planSynchronizationConfigured ? "Configured" : "Disabled"} />
        </dl>
      </DetailSection>

      <DetailSection id="domain" title="Domain Configuration">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Current domain" value={domain.currentDomain} />
          <Field label="Default Vercel domain" value={domain.defaultVercelDomain ?? "Not configured"} />
          <Field label="Custom domain" value={domain.customDomain ?? "Not configured"} />
          <Field label="Domain status" value={domain.domainStatus} />
          <Field label="HTTPS" value={domain.httpsEnabled ? "Enabled" : "Not enabled"} />
          <Field label="Deployment URL" value={domain.deploymentUrl} />
        </dl>
      </DetailSection>

      <DetailSection id="legal" title="Legal Configuration">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Legal name" value={legal.legalName} />
          <Field label="Jurisdiction" value={legal.jurisdiction} />
          <Field label="Registered address" value={legal.legalAddress ?? "Not set"} />
          <Field label="Support email" value={legal.supportEmail ?? "Not set"} />
          <Field label="Privacy Policy effective date" value={legal.privacyEffectiveDate} />
          <Field label="Terms of Service effective date" value={legal.tosEffectiveDate} />
        </dl>
      </DetailSection>

      <DetailSection id="deployment" title="Deployment Information">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Environment" value={deployment.environment ?? "Not set"} />
          <Field
            label="Git commit"
            value={
              deployment.commitUrl ? (
                <a
                  href={deployment.commitUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded font-medium text-black underline hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
                >
                  {deployment.commitShaShort}
                </a>
              ) : (
                (deployment.commitShaShort ?? "Not set")
              )
            }
          />
        </dl>
      </DetailSection>

      <DetailSection id="environment" title="Environment Information">
        <p className="mb-4 text-sm text-gray-600">
          A rollup, not a new source of truth — every row below reflects the same reader each section above already
          calls, never a second, independent read of the underlying configuration.
        </p>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Platform logo" value={branding.logoUrl ? "Set" : "Not set"} />
          <Field label="Favicon" value={branding.faviconUrl ? "Set" : "Not set"} />
          <Field label="Email provider (Resend)" value={email.providerConfigured ? "Configured" : "Not configured"} />
          <Field label="Email sender" value={email.senderConfigured ? "Configured" : "Missing"} />
          <Field label="Email reply-to" value={email.replyToConfigured ? "Configured" : "Fallback"} />
          <Field label="Billing email" value={email.billingEmail ? "Set" : "Not set"} />
          <Field label="Billing provider (Paddle)" value={billing.providerConfigured ? "Configured" : "Not configured"} />
          <Field label="Custom domain" value={domain.customDomain ? "Configured" : "Not configured"} />
          <Field label="Legal registered address" value={legal.legalAddress ? "Set" : "Not set"} />
          <Field label="Legal support email" value={legal.supportEmail ? "Set" : "Not set"} />
        </dl>
      </DetailSection>
    </div>
  );
}
