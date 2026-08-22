import type { Prisma } from "@/generated/prisma/client";
import { resolveNotificationRule, type CreatedActivity, type NotificationContext } from "./notification-rules";

/**
 * Called from inside createActivity, on the same tx as the Activity insert
 * and the business mutation it records — never opens its own transaction,
 * so if the Notification insert below fails, everything in that transaction
 * rolls back together.
 *
 * No-op for any Activity whose (entityType, action) isn't one of the
 * approved MVP NotificationTypes (see notification-rules.ts).
 *
 * Returns the created Notification ids — never used for anything inside
 * the transaction itself, only so the caller (createActivity, then
 * whichever Server Action invoked it) can trigger best-effort email
 * delivery once the transaction has actually committed. Email is never
 * sent from in here: this function only ever runs inside an open
 * transaction, and a provider call has no place blocking (or being rolled
 * back by) a business mutation — see src/lib/notifications/email/deliver-
 * notification-email.ts's own header comment.
 */
export async function dispatchNotificationsForActivity(
  tx: Prisma.TransactionClient,
  input: { activity: CreatedActivity; context?: NotificationContext },
): Promise<string[]> {
  const { activity, context } = input;

  const rule = resolveNotificationRule(activity.entityType, activity.action);
  if (!rule) {
    return [];
  }

  const candidates = await rule.resolveRecipients(tx, activity, context);

  // Exclude the actor and dedupe — done once, uniformly, here rather than
  // per-rule: it's what makes OWNERSHIP_TRANSFERRED's "previous owner"
  // ambiguity resolve correctly (previousOwnerId always equals actorId in
  // every current code path, so it's excluded here rather than needing a
  // special case in that rule), and it satisfies "never notify the actor
  // about their own action" for every rule generically.
  const recipientIds = [...new Set(candidates)].filter((id) => id !== activity.actorId);
  if (recipientIds.length === 0) {
    return [];
  }

  // A deleted/absent recipient (e.g. the inviter's User row no longer
  // exists) must be a silent no-op, not a foreign-key error that would
  // wrongly roll back the whole transaction — so existence is checked
  // before the insert rather than relied on via the FK constraint.
  const existingUsers = await tx.user.findMany({
    where: { id: { in: recipientIds } },
    select: { id: true },
  });
  const existingIds = new Set(existingUsers.map((u) => u.id));
  const finalRecipientIds = recipientIds.filter((id) => existingIds.has(id));
  if (finalRecipientIds.length === 0) {
    return [];
  }

  const metadata = rule.buildMetadata(activity, context);

  const created = await tx.notification.createManyAndReturn({
    data: finalRecipientIds.map((recipientId) => ({
      organizationId: activity.organizationId,
      recipientId,
      activityId: activity.id,
      type: rule.type,
      entityType: activity.entityType,
      entityId: activity.entityId,
      metadata,
    })),
    select: { id: true },
  });

  return created.map((n) => n.id);
}
