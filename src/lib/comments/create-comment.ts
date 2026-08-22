import { prisma } from "@/lib/prisma";
import type { CommentEntityType } from "@/generated/prisma/enums";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { checkRateLimit, COMMENT_CREATE_LIMIT } from "@/lib/rate-limit";
import { createActivity } from "@/lib/activity/create-activity";
import { buildCommentCreatedMetadata } from "@/lib/activity/comment-metadata";
import { deliverNotificationEmails } from "@/lib/notifications/email/deliver-notification-email";
import { resolveCommentTarget } from "./resolve-target";
import { validateCommentBody } from "./validate-body";
import { parseMentionTokens } from "./mentions";
import { buildCommentPreview } from "./preview";

export type CreateCommentResult =
  | { ok: true; commentId: string }
  | { ok: false; error: "rate_limited" | "not_found" | "empty_body" | "body_too_long" };

/**
 * Comments & Mentions Stage 3 (docs/comments-architecture.md §5). The one
 * backend entry point for creating a Project or Task comment — Server
 * Action wrappers (src/app/(dashboard)/projects/[id]/edit/comment-
 * actions.ts, .../tasks/[id]/edit/comment-actions.ts) are thin adapters
 * around exactly this function, never a second copy of its logic.
 *
 * Never accepts organizationId, authorId, recipientIds, or a mention user
 * id list from the caller — identity/org come from
 * getCurrentUserOrganization() alone, and every mentioned user id is
 * derived by parsing `rawBody` and validating against real, current
 * Membership rows inside the same transaction as the write.
 *
 * Invalid/cross-org/non-member/deleted-user mentions are silently
 * ignored, never a reason to reject the whole comment (docs/comments-
 * architecture.md §3, "Invalid mentions" / "Cross-org validation") — only
 * body validation and target resolution can fail the whole call.
 */
export async function createCommentForEntity(params: {
  entityType: CommentEntityType;
  entityId: string;
  rawBody: string;
}): Promise<CreateCommentResult> {
  const { user, organizationId } = await getCurrentUserOrganization();

  const limitCheck = checkRateLimit(COMMENT_CREATE_LIMIT, user.id);
  if (limitCheck.limited) {
    return { ok: false, error: "rate_limited" };
  }

  const bodyValidation = validateCommentBody(params.rawBody);
  if (!bodyValidation.ok) {
    return { ok: false, error: bodyValidation.error === "empty" ? "empty_body" : "body_too_long" };
  }
  const body = bodyValidation.body;

  const parsed = parseMentionTokens(body);

  const outcome = await prisma.$transaction(async (tx) => {
    const target = await resolveCommentTarget(tx, {
      organizationId,
      entityType: params.entityType,
      entityId: params.entityId,
    });
    if (!target) {
      return { status: "not_found" as const };
    }

    // Every candidate mentioned user id, filtered down to real, current
    // members of THIS organization — the one genuinely new validation this
    // feature adds beyond the existing dispatch pipeline's own User-
    // existence check (docs/comments-architecture.md §0.5/§3). Order is
    // preserved from the parser's own first-appearance order; actor
    // exclusion happens here too so a self-mention never even reaches
    // NotificationContext (dispatch-notifications.ts would drop it anyway,
    // but there's nothing for it to drop if it's never included).
    const candidateIds = parsed.uniqueUserIds.filter((id) => id !== user.id);
    const validMemberships =
      candidateIds.length > 0
        ? await tx.membership.findMany({
            where: { organizationId, userId: { in: candidateIds } },
            select: { userId: true },
          })
        : [];
    const validUserIdSet = new Set(validMemberships.map((m) => m.userId));
    const validMentionedUserIds = candidateIds.filter((id) => validUserIdSet.has(id));

    const comment = await tx.comment.create({
      data: {
        organizationId,
        authorId: user.id,
        entityType: params.entityType,
        entityId: target.entityId,
        body,
      },
    });

    if (validMentionedUserIds.length > 0) {
      await tx.commentMention.createMany({
        data: validMentionedUserIds.map((userId) => ({ commentId: comment.id, userId })),
      });
    }

    const activity = await createActivity(tx, {
      organizationId,
      actorId: user.id,
      entityType: "COMMENT",
      entityId: comment.id,
      action: "CREATED",
      metadata: buildCommentCreatedMetadata({
        parentEntityType: target.entityType,
        parentEntityLabel: target.label,
        actorName: user.name,
        commentPreview: buildCommentPreview(body),
        mentionCount: validMentionedUserIds.length,
      }),
      notificationContext:
        validMentionedUserIds.length > 0
          ? { mentionedUserIds: validMentionedUserIds, parentEntityId: target.entityId }
          : undefined,
    });

    return { status: "created" as const, commentId: comment.id, notificationIds: activity.notificationIds };
  });

  if (outcome.status === "not_found") {
    return { ok: false, error: "not_found" };
  }

  // Only ever runs once the transaction above has actually committed — an
  // email provider outage must never roll back the comment, exactly the
  // same discipline every other notification-producing action in this app
  // already follows.
  await deliverNotificationEmails(outcome.notificationIds);

  return { ok: true, commentId: outcome.commentId };
}
