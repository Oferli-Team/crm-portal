import type { Prisma } from "@/generated/prisma/client";
import type { ActivityAction, ActivityEntityType } from "@/generated/prisma/enums";
import { dispatchNotificationsForActivity } from "@/lib/notifications/dispatch-notifications";
import type { CreatedActivity, NotificationContext } from "@/lib/notifications/notification-rules";

export type CreateActivityInput = {
  organizationId: string;
  actorId: string | null;
  entityType: ActivityEntityType;
  entityId: string;
  action: ActivityAction;
  metadata?: Prisma.InputJsonValue;
  /**
   * Raw recipient-resolution IDs for notification fan-out — never persisted
   * to Activity.metadata (which only ever holds human-readable names/emails)
   * and only used, if at all, by dispatchNotificationsForActivity below.
   */
  notificationContext?: NotificationContext;
};

export type CreateActivityResult = CreatedActivity & {
  /**
   * Ids of any Notification rows this Activity fanned out to (empty for
   * every non-notifiable Activity). Only meant for one thing: after the
   * caller's prisma.$transaction(...) resolves, pass these to
   * deliverNotificationEmails(notificationIds) — never call it from inside
   * the transaction itself. See src/lib/notifications/email/deliver-
   * notification-email.ts.
   */
  notificationIds: string[];
};

/**
 * Writes one Activity row, then dispatches any Notification rows it should
 * fan out to. Takes a Prisma.TransactionClient — never the top-level
 * `prisma` client — and never opens its own transaction, so the caller must
 * invoke this from inside the same prisma.$transaction(...) block as the
 * business mutation it's recording: if either insert fails (or throws for
 * any reason), that mutation rolls back with everything else.
 *
 * metadata must only ever contain a safe snapshot/diff (entity name,
 * status, changed field names, actor name) — never full form payloads,
 * tokens, API keys, or other secrets. Never logs its input.
 */
export async function createActivity(
  tx: Prisma.TransactionClient,
  input: CreateActivityInput,
): Promise<CreateActivityResult> {
  const activity = await tx.activity.create({
    data: {
      organizationId: input.organizationId,
      actorId: input.actorId,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      metadata: input.metadata ?? {},
    },
  });

  const notificationIds = await dispatchNotificationsForActivity(tx, {
    activity,
    context: input.notificationContext,
  });

  return { ...activity, notificationIds };
}
