import { prisma } from "@/lib/prisma";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { checkRateLimit, COMMENT_EDIT_LIMIT } from "@/lib/rate-limit";
import { createActivity } from "@/lib/activity/create-activity";
import { buildCommentUpdatedMetadata } from "@/lib/activity/comment-metadata";
import { deliverNotificationEmails } from "@/lib/notifications/email/deliver-notification-email";
import { resolveCommentTarget } from "./resolve-target";
import { validateCommentBody } from "./validate-body";
import { parseMentionTokens } from "./mentions";
import { buildCommentPreview } from "./preview";

export type EditCommentResult =
  | { ok: true; commentId: string; noop: boolean }
  | { ok: false; error: "rate_limited" | "not_found" | "deleted" | "forbidden" | "empty_body" | "body_too_long" };

/**
 * Comments & Mentions Stage 3 (docs/comments-architecture.md §7).
 * Author-only, with no OWNER/ADMIN override — per the design doc, nobody
 * but the original author can change a comment's own words; OWNER/ADMIN's
 * only lever over someone else's comment is moderation-delete (see
 * delete-comment.ts), never a silent edit.
 *
 * Only newly-added mentions ever notify. A mention present before and
 * after the edit, or removed by it, produces no Notification — re-
 * notifying on every wording tweak would be exactly the ambient-noise
 * failure mode this whole feature's notification design (§5) avoids.
 *
 * A true no-op (identical normalized body, identical mention set) writes
 * nothing at all — no Activity row, no `editedAt` bump, no Notification —
 * rather than recording a change that didn't happen.
 */
export async function editComment(params: {
  commentId: string;
  rawBody: string;
}): Promise<EditCommentResult> {
  const { user, organizationId } = await getCurrentUserOrganization();

  const limitCheck = checkRateLimit(COMMENT_EDIT_LIMIT, user.id);
  if (limitCheck.limited) {
    return { ok: false, error: "rate_limited" };
  }

  const bodyValidation = validateCommentBody(params.rawBody);
  if (!bodyValidation.ok) {
    return { ok: false, error: bodyValidation.error === "empty" ? "empty_body" : "body_too_long" };
  }
  const newBody = bodyValidation.body;
  const newParsed = parseMentionTokens(newBody);

  const outcome = await prisma.$transaction(async (tx) => {
    // Scoped by { id, organizationId } together — a foreign-org comment id
    // simply doesn't match, same discipline as every other lookup in this
    // app (never a bare findFirst({ where: { id } })).
    const comment = await tx.comment.findFirst({
      where: { id: params.commentId, organizationId },
      include: { mentions: { select: { userId: true } } },
    });
    if (!comment) {
      return { status: "not_found" as const };
    }
    if (comment.deletedAt) {
      return { status: "deleted" as const };
    }
    if (comment.authorId !== user.id) {
      return { status: "forbidden" as const };
    }

    const target = await resolveCommentTarget(tx, {
      organizationId,
      entityType: comment.entityType,
      entityId: comment.entityId,
    });
    if (!target) {
      return { status: "not_found" as const };
    }

    const candidateIds = newParsed.uniqueUserIds.filter((id) => id !== user.id);
    const validMemberships =
      candidateIds.length > 0
        ? await tx.membership.findMany({
            where: { organizationId, userId: { in: candidateIds } },
            select: { userId: true },
          })
        : [];
    const validUserIdSet = new Set(validMemberships.map((m) => m.userId));
    const newMentionedUserIds = candidateIds.filter((id) => validUserIdSet.has(id));

    const existingMentionedUserIds = comment.mentions.map((m) => m.userId);
    const existingSet = new Set(existingMentionedUserIds);
    const newSet = new Set(newMentionedUserIds);
    const added = newMentionedUserIds.filter((id) => !existingSet.has(id));
    const removed = existingMentionedUserIds.filter((id) => !newSet.has(id));

    const bodyUnchanged = newBody === comment.body;
    if (bodyUnchanged && added.length === 0 && removed.length === 0) {
      return { status: "noop" as const, commentId: comment.id };
    }

    await tx.comment.update({
      where: { id: comment.id },
      data: { body: newBody, editedAt: new Date() },
    });

    if (removed.length > 0) {
      await tx.commentMention.deleteMany({ where: { commentId: comment.id, userId: { in: removed } } });
    }
    if (added.length > 0) {
      await tx.commentMention.createMany({ data: added.map((userId) => ({ commentId: comment.id, userId })) });
    }

    const activity = await createActivity(tx, {
      organizationId,
      actorId: user.id,
      entityType: "COMMENT",
      entityId: comment.id,
      action: "UPDATED",
      metadata: buildCommentUpdatedMetadata({
        parentEntityType: target.entityType,
        parentEntityLabel: target.label,
        actorName: user.name,
        commentPreview: buildCommentPreview(newBody),
        mentionCount: newMentionedUserIds.length,
        addedMentionCount: added.length,
        removedMentionCount: removed.length,
      }),
      notificationContext:
        added.length > 0 ? { mentionedUserIds: added, parentEntityId: target.entityId } : undefined,
    });

    return {
      status: "updated" as const,
      commentId: comment.id,
      notificationIds: activity.notificationIds,
    };
  });

  if (outcome.status === "not_found") return { ok: false, error: "not_found" };
  if (outcome.status === "deleted") return { ok: false, error: "deleted" };
  if (outcome.status === "forbidden") return { ok: false, error: "forbidden" };
  if (outcome.status === "noop") return { ok: true, commentId: outcome.commentId, noop: true };

  await deliverNotificationEmails(outcome.notificationIds);

  return { ok: true, commentId: outcome.commentId, noop: false };
}
