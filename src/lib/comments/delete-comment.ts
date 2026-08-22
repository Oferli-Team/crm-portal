import { prisma } from "@/lib/prisma";
import { getCurrentMembership } from "@/lib/current-user";
import { checkRateLimit, COMMENT_DELETE_LIMIT } from "@/lib/rate-limit";
import { createActivity } from "@/lib/activity/create-activity";
import { buildCommentDeletedMetadata } from "@/lib/activity/comment-metadata";
import { resolveCommentTarget } from "./resolve-target";

export type DeleteCommentResult =
  | { ok: true; alreadyDeleted: boolean }
  | { ok: false; error: "rate_limited" | "not_found" | "forbidden" };

const UNKNOWN_USER_LABEL = "Unknown user";

/**
 * Comments & Mentions Stage 3 (docs/comments-architecture.md §8). Soft
 * delete only — never a hard delete, never physically clears `body` at
 * this layer (the design doc leaves "how/whether to blank the body" to a
 * later UI-facing decision; this backend stage sets `deletedAt` and
 * nothing else). `CommentMention` rows are left untouched on purpose —
 * they remain a historical, accurate record of who was mentioned,
 * independent of whether the comment itself was later removed.
 *
 * Permission: the comment's own author, or an OWNER/ADMIN of this
 * organization (moderation) — a plain MEMBER can never delete someone
 * else's comment. Already-deleted is a genuine idempotent no-op: calling
 * this twice never writes a second DELETED Activity row.
 */
export async function deleteComment(params: { commentId: string }): Promise<DeleteCommentResult> {
  const { user, organizationId, membership } = await getCurrentMembership();

  const limitCheck = checkRateLimit(COMMENT_DELETE_LIMIT, user.id);
  if (limitCheck.limited) {
    return { ok: false, error: "rate_limited" };
  }

  const outcome = await prisma.$transaction(async (tx) => {
    const comment = await tx.comment.findFirst({
      where: { id: params.commentId, organizationId },
      include: { author: { select: { name: true } } },
    });
    if (!comment) {
      return { status: "not_found" as const };
    }

    if (comment.deletedAt) {
      return { status: "already_deleted" as const };
    }

    const isAuthor = comment.authorId === user.id;
    const isModerator = membership.role === "OWNER" || membership.role === "ADMIN";
    if (!isAuthor && !isModerator) {
      return { status: "forbidden" as const };
    }

    const target = await resolveCommentTarget(tx, {
      organizationId,
      entityType: comment.entityType,
      entityId: comment.entityId,
    });

    await tx.comment.update({ where: { id: comment.id }, data: { deletedAt: new Date() } });

    // No NotificationContext — deleting a comment never notifies anyone
    // (docs/comments-architecture.md §5); COMMENT/DELETED has no entry in
    // notification-rules.ts's RULES table at all.
    await createActivity(tx, {
      organizationId,
      actorId: user.id,
      entityType: "COMMENT",
      entityId: comment.id,
      action: "DELETED",
      metadata: buildCommentDeletedMetadata({
        parentEntityType: target?.entityType ?? comment.entityType,
        parentEntityLabel: target?.label ?? "",
        actorName: user.name,
        authorName: comment.author?.name ?? UNKNOWN_USER_LABEL,
        moderated: !isAuthor,
      }),
    });

    return { status: "deleted" as const };
  });

  if (outcome.status === "not_found") return { ok: false, error: "not_found" };
  if (outcome.status === "forbidden") return { ok: false, error: "forbidden" };
  if (outcome.status === "already_deleted") return { ok: true, alreadyDeleted: true };

  return { ok: true, alreadyDeleted: false };
}
