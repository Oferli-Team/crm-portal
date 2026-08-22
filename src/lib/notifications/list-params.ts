import type { Prisma } from "@/generated/prisma/client";
import type { NotificationType } from "@/generated/prisma/enums";
import { parseEnumParam, parseSearchParam, type RawSearchParams } from "@/lib/list-params";
import { decodeActivityCursor, type ActivityCursor } from "@/lib/activity/cursor";

// Deliberately reuses activity/cursor.ts's encode/decode helpers rather than
// a second pagination primitive — the cursor shape ({createdAt, id}) and
// tie-break rule are identical, per docs/notifications-architecture.md §5's
// own "same encode/decode helpers as Activity" guidance. Kept prisma-runtime-
// free (only the `Prisma` type namespace, never the `prisma` client
// singleton) so it stays unit-testable like activity/query.ts.

export const NOTIFICATIONS_PAGE_SIZE = 25;

export const NOTIFICATION_FILTERS = ["all", "unread"] as const;
export type NotificationListFilter = (typeof NOTIFICATION_FILTERS)[number];

export type NotificationListParams = {
  filter: NotificationListFilter;
  cursor: ActivityCursor | null;
  /** True only when a cursor param was present but failed to decode. */
  cursorInvalid: boolean;
};

/** Invalid/missing filter defaults to "all"; invalid cursor degrades to "start over", never a 500. */
export function parseNotificationListParams(searchParams: RawSearchParams): NotificationListParams {
  const filter = parseEnumParam(searchParams.filter, NOTIFICATION_FILTERS) ?? "all";

  const cursorRaw = parseSearchParam(searchParams.cursor);
  const cursor = cursorRaw ? decodeActivityCursor(cursorRaw) : null;
  const cursorInvalid = cursorRaw.length > 0 && cursor === null;

  return { filter, cursor, cursorInvalid };
}

/**
 * organizationId + recipientId are always the first, non-optional
 * conditions — server-resolved by the caller (never from these params),
 * exactly like buildActivityWhere's own organizationId-first discipline.
 *
 * `excludeTypes` is the caller's own, already-fetched result of
 * getDisabledInAppTypes(recipientId) (see src/lib/notifications/
 * preferences.ts) — this function stays prisma-runtime-free and pure, so
 * it takes the list as a plain array rather than fetching it itself.
 */
export function buildNotificationWhere(
  organizationId: string,
  recipientId: string,
  params: NotificationListParams,
  excludeTypes: NotificationType[] = [],
): Prisma.NotificationWhereInput {
  const where: Prisma.NotificationWhereInput = { organizationId, recipientId };

  if (params.filter === "unread") {
    where.readAt = null;
  }

  if (excludeTypes.length > 0) {
    where.type = { notIn: excludeTypes };
  }

  if (params.cursor) {
    const cursorDate = new Date(params.cursor.createdAt);
    // Keyset pagination for ORDER BY createdAt DESC, id DESC — identical
    // tie-break reasoning as buildActivityWhere.
    where.OR = [{ createdAt: { lt: cursorDate } }, { createdAt: cursorDate, id: { lt: params.cursor.id } }];
  }

  return where;
}
