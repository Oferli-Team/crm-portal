import { prisma } from "@/lib/prisma";
import type { Notification } from "@/generated/prisma/client";
import type { NotificationType } from "@/generated/prisma/enums";
import { formatNotification, type NotificationDisplayModel } from "@/lib/notifications/format-notification";
import { NOTIFICATION_TYPES, getDisabledEmailTypes } from "@/lib/notifications/preferences";

/**
 * Digest FOUNDATION only — Stage 8 does not send a digest email, schedule
 * one, or add any cadence/timezone concept to the schema. This module is
 * a pure/query layer a future digest sender would call; it never mutates
 * anything (no readAt, no NotificationDelivery, no email).
 *
 * Open product decisions a real digest still needs, deliberately left
 * unresolved here rather than guessed at:
 *   - Cadence: daily vs. weekly vs. user-configurable.
 *   - Timezone: whose midnight defines a "day" — the org's, or each
 *     recipient's own (this app has no per-user timezone field today).
 *   - Preferred delivery hour: a fixed time, or user-chosen.
 *   - Scope: only unread notifications, or every notification created
 *     since the last digest (read or not) — these produce different
 *     "what's in today's digest" semantics.
 *   - One digest per organization the recipient belongs to, or one
 *     combined digest across all their organizations.
 *   - Interaction with immediate email: does an immediately-emailed
 *     notification (Stage 6/7's per-event delivery) still also appear in
 *     the next digest, or does a digest only cover what wasn't already
 *     emailed? No `digestedAt`-style column exists yet — the design doc's
 *     §7 "Digest emails" bullet flags this as the one new field a real
 *     implementation would add, in its own additive migration, once these
 *     decisions are actually made.
 * None of the above needs a schema change to resolve later — `from`/`to`
 * being caller-supplied already accommodates any cadence/timezone choice.
 */

export type NotificationDigestGroup = {
  type: NotificationType;
  items: (NotificationDisplayModel & { id: string })[];
};

export type NotificationDigestModel = {
  totalCount: number;
  groups: NotificationDigestGroup[];
};

/**
 * Raw candidate rows for a digest window — scoped by recipient AND
 * organization together (never one without the other, same discipline as
 * every other notification query in this app), filtered to the
 * `[from, to)` range, and respecting the recipient's own per-type email
 * preference (a digest is an email-channel concept, so it honors
 * emailEnabled, not inAppEnabled). Never marks anything read, never
 * creates a NotificationDelivery row, never sends anything.
 */
export async function getNotificationDigestCandidates(params: {
  recipientId: string;
  organizationId: string;
  from: Date;
  to: Date;
}): Promise<Notification[]> {
  const excludeTypes = await getDisabledEmailTypes(params.recipientId);

  return prisma.notification.findMany({
    where: {
      recipientId: params.recipientId,
      organizationId: params.organizationId,
      createdAt: { gte: params.from, lt: params.to },
      ...(excludeTypes.length > 0 ? { type: { notIn: excludeTypes } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

/**
 * Pure — no I/O. Dedupes by Notification id (defensive: callers should
 * never hand this duplicate rows, but a digest spanning a boundary a
 * caller re-queries around is an easy way to accidentally do so) and
 * groups by NotificationType, in the same canonical type order the
 * settings page (§7 UI) already uses — a stable layout, not insertion
 * order. Reuses formatNotification (the exact same formatter the in-app
 * bell/list use) rather than a third rendering path — "formatter-ready
 * data" means each item is already a NotificationDisplayModel, exactly
 * what a future digest email template needs to render each row.
 */
export function buildNotificationDigestModel(notifications: Notification[]): NotificationDigestModel {
  const seen = new Set<string>();
  const groupMap = new Map<NotificationType, (NotificationDisplayModel & { id: string })[]>();

  for (const notification of notifications) {
    if (seen.has(notification.id)) continue;
    seen.add(notification.id);

    const display = formatNotification({
      type: notification.type,
      metadata: notification.metadata,
      entityId: notification.entityId,
      createdAt: notification.createdAt,
      readAt: notification.readAt,
    });

    const items = groupMap.get(notification.type) ?? [];
    items.push({ id: notification.id, ...display });
    groupMap.set(notification.type, items);
  }

  const groups = NOTIFICATION_TYPES.filter((type) => groupMap.has(type)).map((type) => ({
    type,
    items: groupMap.get(type)!,
  }));

  return { totalCount: seen.size, groups };
}
