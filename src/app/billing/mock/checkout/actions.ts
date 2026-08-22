"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { TEST_MODE } from "@/lib/test-mode";
import { getCurrentMembership } from "@/lib/current-user";
import { Role } from "@/generated/prisma/enums";
import { isPurchasablePlanKey } from "@/lib/billing/plan-selection";
import { sanitizeRedirectPath } from "@/lib/safe-redirect";
import {
  buildMockWebhookRequest,
  deriveMockCustomerId,
  deriveMockSubscriptionId,
  mockPeriodEnd,
} from "@/lib/billing/provider/mock-provider";
import { postMockWebhookEvent } from "../mock-webhook-client";

/**
 * Billing & Subscriptions Stage 4 (this stage's own §14). Never updates
 * Subscription directly — builds and signs a real SUBSCRIPTION_ACTIVATED
 * event, then POSTs it to the real `/api/billing/webhook` route (the only
 * thing that ever writes a Subscription row). Re-resolves the caller's own
 * session server-side rather than trusting anything from the checkout
 * page's own query string/form fields beyond planKey/returnUrl.
 */
export async function completeMockCheckoutAction(formData: FormData): Promise<void> {
  if (!TEST_MODE) {
    throw new Error("Mock checkout is only available in TEST_MODE.");
  }

  const { organizationId, membership } = await getCurrentMembership();
  if (membership.role !== Role.OWNER) {
    throw new Error("Only the organization owner can complete checkout.");
  }

  const planKey = String(formData.get("planKey") ?? "");
  if (!isPurchasablePlanKey(planKey)) {
    throw new Error("That plan isn't available.");
  }

  const returnUrl = sanitizeRedirectPath(String(formData.get("returnUrl") ?? ""), "/settings/billing");
  const now = new Date();

  const { rawBody, signatureHeader } = buildMockWebhookRequest({
    eventType: "SUBSCRIPTION_ACTIVATED",
    organizationId,
    providerCustomerId: deriveMockCustomerId(organizationId),
    providerSubscriptionId: deriveMockSubscriptionId(organizationId),
    planKey,
    status: "ACTIVE",
    currentPeriodStart: now,
    currentPeriodEnd: mockPeriodEnd(now),
    cancelAtPeriodEnd: false,
    trialEnd: null,
    now,
    providerEventId: randomUUID(),
  });

  await postMockWebhookEvent(rawBody, signatureHeader);

  redirect(returnUrl);
}
