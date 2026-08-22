"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { TEST_MODE } from "@/lib/test-mode";
import { getCurrentMembership } from "@/lib/current-user";
import { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { sanitizeRedirectPath } from "@/lib/safe-redirect";
import { buildMockWebhookRequest } from "@/lib/billing/provider/mock-provider";
import { postMockWebhookEvent } from "../mock-webhook-client";
import type { SubscriptionStatus } from "@/generated/prisma/enums";
import type { BillingProviderEventType } from "@/lib/billing/provider/types";

/**
 * Billing & Subscriptions Stage 4 (this stage's own §14). Three simulated
 * outcomes a real Customer Portal visit could produce — every one of them
 * builds and signs a real webhook event from the org's *actual current*
 * mock Subscription row (never a client-supplied plan/status) and POSTs it
 * to the real webhook route; this action itself never writes to
 * Subscription.
 */
export type MockPortalSimulation = "PAYMENT_FAILED" | "CANCEL" | "PLAN_CHANGE";

const SIMULATION_EVENT_TYPE: Record<MockPortalSimulation, BillingProviderEventType> = {
  PAYMENT_FAILED: "SUBSCRIPTION_PAST_DUE",
  CANCEL: "SUBSCRIPTION_CANCELED",
  PLAN_CHANGE: "SUBSCRIPTION_UPDATED",
};

export async function simulateMockPortalEventAction(formData: FormData): Promise<void> {
  if (!TEST_MODE) {
    throw new Error("The mock portal is only available in TEST_MODE.");
  }

  const { organizationId, membership } = await getCurrentMembership();
  if (membership.role !== Role.OWNER) {
    throw new Error("Only the organization owner can manage billing.");
  }

  const kind = String(formData.get("kind") ?? "") as MockPortalSimulation;
  if (!(kind in SIMULATION_EVENT_TYPE)) {
    throw new Error("Unknown simulation.");
  }
  const returnUrl = sanitizeRedirectPath(String(formData.get("returnUrl") ?? ""), "/settings/billing");

  const subscription = await prisma.subscription.findUnique({ where: { organizationId } });
  if (!subscription?.providerCustomerId || !subscription.providerSubscriptionId) {
    throw new Error("No mock subscription to simulate against.");
  }

  const now = new Date();
  let status: SubscriptionStatus = subscription.status;
  let planKey = subscription.planKey;
  let cancelAtPeriodEnd = subscription.cancelAtPeriodEnd;

  if (kind === "PAYMENT_FAILED") {
    status = "PAST_DUE";
  } else if (kind === "CANCEL") {
    status = "CANCELED";
    cancelAtPeriodEnd = true;
  } else {
    // PLAN_CHANGE: a simple toggle between the two purchasable plans —
    // enough to exercise the mapper's own plan-change/PLAN_CHANGED
    // notification path without needing a plan picker on this page.
    status = "ACTIVE";
    planKey = subscription.planKey === "PRO" ? "STARTER" : "PRO";
  }

  const { rawBody, signatureHeader } = buildMockWebhookRequest({
    eventType: SIMULATION_EVENT_TYPE[kind],
    organizationId,
    providerCustomerId: subscription.providerCustomerId,
    providerSubscriptionId: subscription.providerSubscriptionId,
    planKey,
    status,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelAtPeriodEnd,
    trialEnd: null,
    now,
    providerEventId: randomUUID(),
  });

  await postMockWebhookEvent(rawBody, signatureHeader);

  redirect(returnUrl);
}
