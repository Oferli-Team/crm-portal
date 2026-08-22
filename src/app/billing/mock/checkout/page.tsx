import { notFound } from "next/navigation";
import Link from "next/link";
import { TEST_MODE } from "@/lib/test-mode";
import { getCurrentMembership } from "@/lib/current-user";
import { Role } from "@/generated/prisma/enums";
import { isPurchasablePlanKey } from "@/lib/billing/plan-selection";
import { getPlan } from "@/lib/billing/plans";
import { sanitizeRedirectPath } from "@/lib/safe-redirect";
import { completeMockCheckoutAction } from "./actions";

// Without this, Next.js's static analysis sees the `if (!TEST_MODE)
// notFound()` early-return short-circuit before any dynamic API
// (cookies(), via getCurrentMembership()) is ever reached, and — since
// TEST_MODE is false at build time — statically prerenders this page as a
// permanently-cached 404. That cached output would then be served
// unconditionally at runtime too, even under a real TEST_MODE=1 process
// (Playwright's E2E run), never re-evaluating this check per-request.
// Forcing dynamic rendering, the same as every cron route and the webhook
// route, is what makes this page actually re-run its TEST_MODE check on
// every request instead of once at build time.
export const dynamic = "force-dynamic";

/**
 * Billing & Subscriptions Stage 4 (this stage's own §4/§14). A full,
 * TEST_MODE-only stand-in for a real provider's hosted checkout page —
 * 404s unconditionally outside TEST_MODE, before reading anything else,
 * the same gate src/app/api/e2e-test-storage/[...path]/route.ts already
 * uses. Never collects a card number, email, or billing address (there is
 * none to collect); the only thing this page ever does is let the
 * (already-authenticated, already-OWNER) caller confirm or cancel a
 * simulated purchase.
 */
export default async function MockCheckoutPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!TEST_MODE) {
    notFound();
  }

  const params = await searchParams;
  const organizationIdParam = typeof params.organizationId === "string" ? params.organizationId : "";
  const planKeyParam = typeof params.planKey === "string" ? params.planKey : "";
  const returnUrl = sanitizeRedirectPath(typeof params.returnUrl === "string" ? params.returnUrl : null, "/settings/billing");
  const cancelUrl = sanitizeRedirectPath(typeof params.cancelUrl === "string" ? params.cancelUrl : null, "/settings/billing");

  // Re-resolved server-side — the query string's own organizationId is
  // never trusted as an authorization decision, only compared against it.
  const { organizationId, membership } = await getCurrentMembership();
  if (membership.role !== Role.OWNER || organizationId !== organizationIdParam) {
    notFound();
  }

  if (!isPurchasablePlanKey(planKeyParam)) {
    notFound();
  }
  const plan = getPlan(planKeyParam);

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-16">
      <p className="text-xs font-semibold tracking-wide text-amber-600 uppercase">Mock checkout — TEST_MODE only</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-gray-900">Subscribe to {plan.displayName}</h1>
      <p className="mt-2 text-sm text-gray-500">
        This is a simulated checkout page. No real payment is collected, and no card details are ever asked for.
      </p>

      <form action={completeMockCheckoutAction} className="mt-8 space-y-3">
        <input type="hidden" name="planKey" value={planKeyParam} />
        <input type="hidden" name="returnUrl" value={returnUrl} />
        <button
          type="submit"
          className="w-full rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800"
        >
          Complete purchase
        </button>
      </form>

      <Link href={cancelUrl} className="mt-3 text-center text-sm text-gray-500 hover:text-gray-700">
        Cancel and return
      </Link>
    </div>
  );
}
