import type { Prisma } from "@/generated/prisma/client";

/**
 * Billing & Subscriptions Stage 4 (docs/billing-architecture.md §17, this
 * stage's own §12/§13). Deliberately bypasses createActivity()/
 * dispatchNotificationsForActivity() (src/lib/activity/create-activity.ts,
 * src/lib/notifications/dispatch-notifications.ts) rather than routing
 * through them: a webhook event has no human actor, and no
 * ActivityEntityType/ActivityAction value fits "a Subscription changed"
 * without adding a second, unconfirmed enum surface beyond the
 * NotificationType values this stage already added. Notification.activityId/
 * entityType/entityId are all nullable specifically for this shape — see
 * that model's own doc comment in schema.prisma ("a future scheduled job
 * writes a Notification with no Activity row behind it at all, since
 * nothing 'happened' in the Activity sense"), which this is a direct
 * instance of, not a new precedent.
 *
 * Every one of these four types notifies the organization's OWNER only
 * (docs/billing-architecture.md §17's own table) — resolved fresh here via
 * a Membership query, never trusted from caller input.
 */

export type BillingNotificationType =
  | "SUBSCRIPTION_ACTIVATED"
  | "PAYMENT_FAILED"
  | "SUBSCRIPTION_CANCELED"
  | "PLAN_CHANGED";

/** Display-safe only — a plan's catalog displayName, never a providerCustomerId/providerSubscriptionId/raw payload field (this stage's own §16 "no raw payload/provider details leaked" rule). */
export type BillingNotificationMetadata = {
  planName: string;
  previousPlanName?: string;
};

/**
 * Returns the created Notification id, or `null` if this organization
 * somehow has no OWNER Membership (should never happen — every org always
 * has exactly one — but this must degrade to a silent no-op rather than
 * throw and fail the whole webhook transaction over a notification that
 * can't be delivered to anyone).
 */
export async function createBillingNotification(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; type: BillingNotificationType; metadata: BillingNotificationMetadata },
): Promise<string | null> {
  const owner = await tx.membership.findFirst({
    where: { organizationId: input.organizationId, role: "OWNER" },
    select: { userId: true },
  });
  if (!owner) return null;

  const notification = await tx.notification.create({
    data: {
      organizationId: input.organizationId,
      recipientId: owner.userId,
      type: input.type,
      metadata: input.metadata as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  return notification.id;
}
