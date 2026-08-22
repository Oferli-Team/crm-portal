import { prisma } from "@/lib/prisma";
import type { Comment, CommentMention } from "@/generated/prisma/client";
import type { CommentEntityType } from "@/generated/prisma/enums";
import { encodeActivityCursor, decodeActivityCursor, type ActivityCursor } from "@/lib/activity/cursor";
import { resolveCommentTarget } from "./resolve-target";

export const COMMENT_PAGE_SIZE = 20;

export type CommentRow = Comment & {
  author: { id: string; name: string; email: string } | null;
  mentions: Pick<CommentMention, "id" | "userId">[];
};

export type CommentsPageResult = {
  comments: CommentRow[];
  nextCursor: string | null;
  cursorInvalid: boolean;
};

/**
 * Comments & Mentions Stage 3 (docs/comments-architecture.md §7/§11) — the
 * read-query contract the (not-yet-built) Stage 4 UI will call. Backend-
 * only: no PortalUser path exists here at all (this function takes a
 * server-resolved organizationId, the same convention getNotificationsPage
 * already uses — the caller, a future staff-only Server Component, is
 * responsible for resolving it via getCurrentUserOrganization() first;
 * this function itself never reads a session or cookie).
 *
 * Target ownership is verified up front — an invalid/cross-org/nonexistent
 * target returns an empty page, indistinguishable from "this Project/Task
 * genuinely has zero comments," never a thrown error that could leak
 * existence through an error message.
 *
 * Ordering matches Activity/Notifications exactly: `createdAt DESC, id
 * DESC` (newest-first), reusing the identical keyset cursor helper — the
 * design doc's own UI plan (§6) reverses this for oldest-first display,
 * which is the future UI layer's concern, not this query's.
 *
 * Soft-deleted rows are returned like any other row — deletedAt/body are
 * not filtered or redacted here; hiding the body behind a placeholder is
 * the formatter's job (format-comment.ts), not the query's.
 */
export async function getCommentsPage(params: {
  organizationId: string;
  entityType: CommentEntityType;
  entityId: string;
  cursor?: string | null;
  limit?: number;
}): Promise<CommentsPageResult> {
  const { organizationId, entityType, entityId } = params;
  const limit = params.limit && params.limit > 0 ? params.limit : COMMENT_PAGE_SIZE;

  const target = await resolveCommentTarget(prisma, { organizationId, entityType, entityId });
  if (!target) {
    return { comments: [], nextCursor: null, cursorInvalid: false };
  }

  const cursorRaw = params.cursor ?? null;
  const cursor: ActivityCursor | null = cursorRaw ? decodeActivityCursor(cursorRaw) : null;
  const cursorInvalid = cursorRaw !== null && cursorRaw.length > 0 && cursor === null;

  // Over-fetch by one to detect "is there a next page" without a second
  // count query — identical trick to the Notifications inbox's own
  // pagination (getNotificationsPage).
  const rows = await prisma.comment.findMany({
    where: {
      organizationId,
      entityType,
      entityId,
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: new Date(cursor.createdAt) } },
              { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: {
      author: { select: { id: true, name: true, email: true } },
      mentions: { select: { id: true, userId: true } },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeActivityCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null;

  return { comments: page, nextCursor, cursorInvalid };
}
