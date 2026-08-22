"use server";

import { revalidatePath } from "next/cache";
import { RATE_LIMIT_MESSAGE } from "@/lib/rate-limit";
import { createCommentForEntity } from "@/lib/comments/create-comment";
import { editComment } from "@/lib/comments/edit-comment";
import { deleteComment } from "@/lib/comments/delete-comment";
import { COMMENT_BODY_MAX_LENGTH } from "@/lib/comments/validate-body";
import type { CommentActionState } from "@/types";

/**
 * Comments & Mentions Stage 3 (docs/comments-architecture.md §5) — the
 * Task-side counterpart to projects/[id]/edit/comment-actions.ts. Same
 * shared backend helpers, same thin-wrapper discipline; see that file's
 * own header comment for the full reasoning.
 */
export async function createTaskCommentAction(
  taskId: string,
  _prevState: CommentActionState,
  formData: FormData,
): Promise<CommentActionState> {
  const result = await createCommentForEntity({
    entityType: "TASK",
    entityId: taskId,
    rawBody: String(formData.get("body") ?? ""),
  });

  if (!result.ok) {
    return { error: mapCreateError(result.error) };
  }

  revalidatePath(`/tasks/${taskId}/edit`);
  return { error: null };
}

export async function editTaskCommentAction(
  taskId: string,
  commentId: string,
  _prevState: CommentActionState,
  formData: FormData,
): Promise<CommentActionState> {
  const result = await editComment({ commentId, rawBody: String(formData.get("body") ?? "") });

  if (!result.ok) {
    return { error: mapEditError(result.error) };
  }

  if (!result.noop) {
    revalidatePath(`/tasks/${taskId}/edit`);
  }
  return { error: null };
}

export async function deleteTaskCommentAction(taskId: string, commentId: string): Promise<void> {
  await deleteComment({ commentId });
  revalidatePath(`/tasks/${taskId}/edit`);
}

function mapCreateError(error: "rate_limited" | "not_found" | "empty_body" | "body_too_long"): string {
  switch (error) {
    case "rate_limited":
      return RATE_LIMIT_MESSAGE;
    case "not_found":
      return "This task could not be found.";
    case "empty_body":
      return "Write something before posting.";
    case "body_too_long":
      return `Comment is too long (max ${COMMENT_BODY_MAX_LENGTH} characters).`;
  }
}

function mapEditError(
  error: "rate_limited" | "not_found" | "deleted" | "forbidden" | "empty_body" | "body_too_long",
): string {
  switch (error) {
    case "rate_limited":
      return RATE_LIMIT_MESSAGE;
    case "not_found":
      return "This comment could not be found.";
    case "deleted":
      return "This comment has already been deleted.";
    case "forbidden":
      return "You can only edit your own comments.";
    case "empty_body":
      return "Write something before posting.";
    case "body_too_long":
      return `Comment is too long (max ${COMMENT_BODY_MAX_LENGTH} characters).`;
  }
}
