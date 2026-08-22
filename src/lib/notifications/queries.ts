import { prisma } from "@/lib/prisma";
import type { Notification, Prisma } from "@/generated/prisma/client";
import type { NotificationType } from "@/generated/prisma/enums";
import { encodeActivityCursor } from "@/lib/activity/cursor";
import { NOTIFICATIONS_PAGE_SIZE } from "@/lib/notifications/list-params";

/**
 * Served by the [recipientId, readAt, createdAt, id] index — readAt IS NULL
 * is a highly selective prefix match, so this stays an index-only count
 * rather than a full-table scan (see docs/notifications-architecture.md §5).
 *
 * `excludeTypes` is the caller's own, already-fetched result of
 * getDisabledInAppTypes(recipientId) (see src/lib/notifications/
 * preferences.ts) — this function never queries preferences itself, so
 * calling it alongside getRecentNotifications/getNotificationsPage in the
 * same request never re-fetches the same small preference set twice.
 */
export async function getUnreadNotificationCount(params: {
  organizationId: string;
  recipientId: string;
  excludeTypes?: NotificationType[];
}): Promise<number> {
  return prisma.notification.count({
    where: {
      organizationId: params.organizationId,
      recipientId: params.recipientId,
      readAt: null,
      ...(params.excludeTypes && params.excludeTypes.length > 0
        ? { type: { notIn: params.excludeTypes } }
        : {}),
    },
  });
}

/**
 * The dropdown's preview list — a plain LIMIT, not cursor pagination. The
 * full, paginated inbox (keyset, mirroring /activity's cursor.ts) is a
 * future /notifications page's concern, not this preview's.
 *
 * `excludeTypes` — see getUnreadNotificationCount's own comment above.
 */
export async function getRecentNotifications(params: {
  organizationId: string;
  recipientId: string;
  limit: number;
  excludeTypes?: NotificationType[];
}): Promise<Notification[]> {
  return prisma.notification.findMany({
    where: {
      organizationId: params.organizationId,
      recipientId: params.recipientId,
      ...(params.excludeTypes && params.excludeTypes.length > 0
        ? { type: { notIn: params.excludeTypes } }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: params.limit,
  });
}

// --- Full /notifications inbox: keyset pagination ----------------------
// parseNotificationListParams/buildNotificationWhere live in
// list-params.ts, which stays prisma-runtime-free (only the `Prisma` type
// namespace) so they're unit-testable the same way activity/query.ts is —
// this file is only the actual DB round-trip.

export type NotificationsPage = {
  rows: Notification[];
  hasMore: boolean;
  nextCursor: string | null;
};

/** where must already be scoped by buildNotificationWhere (organizationId + recipientId). */
export async function getNotificationsPage(where: Prisma.NotificationWhereInput): Promise<NotificationsPage> {
  const rows = await prisma.notification.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: NOTIFICATIONS_PAGE_SIZE + 1,
  });

  const hasMore = rows.length > NOTIFICATIONS_PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, NOTIFICATIONS_PAGE_SIZE) : rows;
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && lastRow ? encodeActivityCursor({ createdAt: lastRow.createdAt.toISOString(), id: lastRow.id }) : null;

  return { rows: pageRows, hasMore, nextCursor };
}
