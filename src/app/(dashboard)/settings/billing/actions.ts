"use server";

import { redirect } from "next/navigation";
import { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { getCurrentMembership } from "@/lib/current-user";
import { isPurchasablePlanKey } from "@/lib/billing/plan-selection";
import { getBillingProviderAdapter } from "@/lib/billing/provider/provider";
import { sanitizeRedirectPath } from "@/lib/safe-redirect";
import { checkRateLimit, BILLING_CHECKOUT_LIMIT, BILLING_PORTAL_LIMIT, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit";

/**
 * Billing & Subscriptions Stage 4 (this stage's own §5/§6). Replaces Stage
 * 3's placeholder body — the authorization/validation shape it left in
 * place (OWNER-only, server-resolved org, allowlisted plan key) is
 * unchanged; only what happens once a provider *is* configured is new.
 *
 * Neither action ever writes to Subscription/WebhookEvent — a checkout or
 * portal session only ever *redirects the browser*; the only thing that
 * ever mutates a Subscription row is the webhook route
 * (src/app/api/billing/webhook/route.ts) processing a real, signed event
 * back from whichever adapter (mock or eventually real) issued the
 * session in the first place. "One active subscription per org" is
 * already a schema-level guarantee (Subscription.organizationId is
 * unique) — nothing here needs to re-enforce it.
 *
 * Return/cancel URLs are never client-supplied — always this fixed,
 * same-origin `/settings/billing` path, run through sanitizeRedirectPath
 * anyway as defense in depth even though there is no variable input to
 * sanitize. The portal/checkout session URL an adapter hands back *is*
 * trusted to redirect to (including cross-origin, for a real provider's
 * own hosted checkout/portal) — that URL was never client input, it's
 * this server's own adapter call talking to the provider directly (or,
 * for the mock, a same-origin path this app itself defines).
 */

export type BillingActionResult = { ok: true; message: string } | { ok: false; message: string };

const NOT_OWNER_MESSAGE = "Only the organization owner can manage billing.";
const INVALID_PLAN_MESSAGE = "That plan isn't available.";
const NOT_CONFIGURED_MESSAGE = "Billing provider is not configured.";
const NO_BILLING_ACCOUNT_MESSAGE = "There's no billing account to manage yet — upgrade to a paid plan first.";
const CHECKOUT_ERROR_MESSAGE = "Something went wrong starting checkout. Please try again.";
const PORTAL_ERROR_MESSAGE = "Something went wrong opening the billing portal. Please try again.";

const BILLING_PAGE_PATH = "/settings/billing";

function billingReturnUrl(status: "success" | "cancel"): string {
  return sanitizeRedirectPath(`${BILLING_PAGE_PATH}?checkout=${status}`, BILLING_PAGE_PATH);
}

/** planKey is client input — always validated against the compile-time catalog and its billingAvailable flag, never trusted. organizationId/role are never accepted as parameters; they are always resolved server-side via getCurrentMembership(). */
export async function requestPlanChangeAction(planKey: string): Promise<BillingActionResult> {
  const { user, organizationId, membership } = await getCurrentMembership();

  if (membership.role !== Role.OWNER) {
    return { ok: false, message: NOT_OWNER_MESSAGE };
  }

  if (!isPurchasablePlanKey(planKey)) {
    return { ok: false, message: INVALID_PLAN_MESSAGE };
  }

  const adapter = getBillingProviderAdapter();
  if (adapter.kind === "unconfigured") {
    return { ok: false, message: NOT_CONFIGURED_MESSAGE };
  }

  const limitCheck = checkRateLimit(BILLING_CHECKOUT_LIMIT, user.id);
  if (limitCheck.limited) {
    return { ok: false, message: RATE_LIMIT_MESSAGE };
  }

  // Reused if this org already has a provider customer (e.g. switching
  // plans again later) — never creates a second one for the same org.
  const existing = await prisma.subscription.findUnique({
    where: { organizationId },
    select: { providerCustomerId: true },
  });

  let session;
  try {
    session = await adapter.createCheckoutSession({
      organizationId,
      planKey,
      returnUrl: billingReturnUrl("success"),
      cancelUrl: billingReturnUrl("cancel"),
      existingProviderCustomerId: existing?.providerCustomerId ?? null,
    });
  } catch {
    return { ok: false, message: CHECKOUT_ERROR_MESSAGE };
  }

  redirect(session.url);
}

/** No parameters at all — the subscription being managed is always the caller's own active organization's, resolved server-side. */
export async function manageSubscriptionAction(): Promise<BillingActionResult> {
  const { user, organizationId, membership } = await getCurrentMembership();

  if (membership.role !== Role.OWNER) {
    return { ok: false, message: NOT_OWNER_MESSAGE };
  }

  const adapter = getBillingProviderAdapter();
  if (adapter.kind === "unconfigured") {
    return { ok: false, message: NOT_CONFIGURED_MESSAGE };
  }

  const limitCheck = checkRateLimit(BILLING_PORTAL_LIMIT, user.id);
  if (limitCheck.limited) {
    return { ok: false, message: RATE_LIMIT_MESSAGE };
  }

  const subscription = await prisma.subscription.findUnique({
    where: { organizationId },
    select: { providerCustomerId: true },
  });

  if (!subscription?.providerCustomerId) {
    return { ok: false, message: NO_BILLING_ACCOUNT_MESSAGE };
  }

  let session;
  try {
    session = await adapter.createCustomerPortalSession({
      organizationId,
      providerCustomerId: subscription.providerCustomerId,
      returnUrl: billingReturnUrl("success"),
    });
  } catch {
    return { ok: false, message: PORTAL_ERROR_MESSAGE };
  }

  redirect(session.url);
}
