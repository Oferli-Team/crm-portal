import { getOrganizationEntitlements } from "@/lib/billing/entitlements";
import type { BillingMetrics, PrismaClientOrTx, TimeRangeBounds } from "../types";

/**
 * Analytics Stage 1 (docs/analytics-architecture.md §5.5). Deliberately a
 * thin wrapper over src/lib/billing/entitlements.ts's own
 * `getOrganizationEntitlements()` — read-only reuse of Billing's own
 * planKey/LEGACY-normalization logic (Stage 5 audit fix), never a
 * reimplementation. This is the one query in the analytics domain that
 * reaches into another domain's module; every other query file only ever
 * touches Prisma directly.
 */
export async function getBillingMetrics(client: PrismaClientOrTx, organizationId: string, now: Date): Promise<BillingMetrics> {
  const [entitlements, subscriptionEventCount] = await Promise.all([
    getOrganizationEntitlements(organizationId, { client, now }),
    getSubscriptionEventCount(client, organizationId, { start: null, end: now }),
  ]);
  return {
    planKey: entitlements.planKey,
    subscriptionStatus: entitlements.subscriptionStatus,
    subscriptionEventCount,
  };
}

/**
 * Analytics Stage 3 ("subscription status transitions — aggregate only").
 * A single `count` against `WebhookEvent.processingStatus` — never the
 * event rows themselves, never `eventType`/`providerEventId`/any other
 * column, and never a per-event timeline. This is the one place Analytics
 * touches `WebhookEvent` at all; it never reads or renders anything about
 * an individual event, only how many successfully-processed ones exist
 * for this organization in the given window.
 */
export async function getSubscriptionEventCount(
  client: PrismaClientOrTx,
  organizationId: string,
  bounds: TimeRangeBounds,
): Promise<number> {
  return client.webhookEvent.count({
    where: {
      organizationId,
      processingStatus: "PROCESSED",
      ...(bounds.start ? { createdAt: { gte: bounds.start, lte: bounds.end } } : { createdAt: { lte: bounds.end } }),
    },
  });
}
