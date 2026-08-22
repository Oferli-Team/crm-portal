import { getCurrentMembership } from "@/lib/current-user";
import { getBillingPageData } from "@/lib/billing/view-model";
import { AccessModeBanner } from "@/components/billing/access-mode-banner";
import { CurrentPlanSection } from "@/components/billing/current-plan-section";
import { UsageSection } from "@/components/billing/usage-section";
import { PlansSection } from "@/components/billing/plans-section";
import { NoticeBanner } from "@/components/billing/notice-banner";

/**
 * Billing & Subscriptions Stage 3 (this stage's own §2/§3/§4). Staff-only
 * by construction — this route lives under (dashboard), whose layout
 * already redirects any Client Portal-only identity to /portal before this
 * page ever renders (src/app/(dashboard)/layout.tsx). organizationId and
 * role are always server-resolved via getCurrentMembership() — never
 * accepted from the client.
 *
 * Every staff role (OWNER/ADMIN/MEMBER) can view this page — role only
 * gates which controls are interactive (getBillingPageData's own
 * `permissions` field, rendered by CurrentPlanSection/PlansSection). No
 * 500/crash path: getBillingPageData never throws for a missing
 * Subscription row (that's the LEGACY state, not an error) or an
 * unrecognized planKey (falls back to a generic label).
 *
 * Billing & Subscriptions Stage 4 (this stage's own §5): `?checkout=`
 * never itself activates or mutates anything — it's a pure display hint
 * from the checkout/portal actions' own fixed return URL
 * (src/app/(dashboard)/settings/billing/actions.ts). The page always
 * still renders whatever the *real*, current Subscription state is; only
 * a real webhook delivery (src/app/api/billing/webhook/route.ts) ever
 * changes it. Against a real provider, that delivery can genuinely still
 * be in flight the moment this page loads — the notice below is what
 * covers that gap; against the TEST_MODE mock, the webhook has already
 * been delivered synchronously by the time the browser gets here, so the
 * notice is typically never even visible before the real state shows.
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { organizationId, membership } = await getCurrentMembership();
  const data = await getBillingPageData({ organizationId, role: membership.role });
  const { checkout } = await searchParams;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Billing</h1>
      <p className="mt-1 text-sm text-gray-500">Manage your organization&apos;s plan and usage.</p>

      <div className="mt-6 space-y-6">
        {checkout === "success" && (
          <NoticeBanner notice={{ id: "checkout-success", tone: "info", message: "Payment received — waiting for confirmation. This page will reflect your new plan once it's processed." }} />
        )}
        {checkout === "cancel" && (
          <NoticeBanner notice={{ id: "checkout-cancel", tone: "neutral", message: "Checkout was canceled — your plan is unchanged." }} />
        )}
        <AccessModeBanner banner={data.accessModeBanner} />
        <CurrentPlanSection data={data} />
        <UsageSection rows={data.usageRows} />
        <PlansSection data={data} />
      </div>
    </div>
  );
}
