import { notFound } from "next/navigation";
import Link from "next/link";
import { TEST_MODE } from "@/lib/test-mode";
import { getCurrentMembership } from "@/lib/current-user";
import { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { sanitizeRedirectPath } from "@/lib/safe-redirect";
import { simulateMockPortalEventAction } from "./actions";

// See src/app/billing/mock/checkout/page.tsx's own comment on this same
// export — without it, this page would be statically prerendered as a
// permanent 404 at build time (TEST_MODE is false during `npm run build`)
// and never re-evaluate its TEST_MODE check at runtime.
export const dynamic = "force-dynamic";

/**
 * Billing & Subscriptions Stage 4 (this stage's own §6/§14). A full,
 * TEST_MODE-only stand-in for a real provider's hosted Customer Portal —
 * 404s unconditionally outside TEST_MODE. Shows the organization's real,
 * current mock subscription state (read fresh from the database, never
 * from a query param) and offers a few simulated outcomes, each of which
 * only ever takes effect by round-tripping through the real webhook route
 * (see ./actions.ts) — this page never writes to Subscription itself.
 */
export default async function MockPortalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!TEST_MODE) {
    notFound();
  }

  const params = await searchParams;
  const organizationIdParam = typeof params.organizationId === "string" ? params.organizationId : "";
  const returnUrl = sanitizeRedirectPath(typeof params.returnUrl === "string" ? params.returnUrl : null, "/settings/billing");

  const { organizationId, membership } = await getCurrentMembership();
  if (membership.role !== Role.OWNER || organizationId !== organizationIdParam) {
    notFound();
  }

  const subscription = await prisma.subscription.findUnique({ where: { organizationId } });
  if (!subscription?.providerCustomerId) {
    notFound();
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-16">
      <p className="text-xs font-semibold tracking-wide text-amber-600 uppercase">Mock customer portal — TEST_MODE only</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-gray-900">Manage subscription</h1>
      <p className="mt-2 text-sm text-gray-500">
        Plan: {subscription.planKey} · Status: {subscription.status}
      </p>

      <div className="mt-8 space-y-3">
        <form action={simulateMockPortalEventAction}>
          <input type="hidden" name="kind" value="PLAN_CHANGE" />
          <input type="hidden" name="returnUrl" value={returnUrl} />
          <button
            type="submit"
            className="w-full rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Simulate plan change
          </button>
        </form>

        <form action={simulateMockPortalEventAction}>
          <input type="hidden" name="kind" value="PAYMENT_FAILED" />
          <input type="hidden" name="returnUrl" value={returnUrl} />
          <button
            type="submit"
            className="w-full rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Simulate payment failure
          </button>
        </form>

        <form action={simulateMockPortalEventAction}>
          <input type="hidden" name="kind" value="CANCEL" />
          <input type="hidden" name="returnUrl" value={returnUrl} />
          <button
            type="submit"
            className="w-full rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Simulate cancel
          </button>
        </form>
      </div>

      <Link href={returnUrl} className="mt-6 text-center text-sm text-gray-500 hover:text-gray-700">
        Back to Billing
      </Link>
    </div>
  );
}
