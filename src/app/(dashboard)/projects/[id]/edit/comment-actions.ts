"use server";

import { revalidatePath } from "next/cache";
import { RATE_LIMIT_MESSAGE } from "@/lib/rate-limit";
import { createCommentForEntity } from "@/lib/comments/create-comment";
import { editComment } from "@/lib/comments/edit-comment";
import { deleteComment } from "@/lib/comments/delete-comment";
import { COMMENT_BODY_MAX_LENGTH } from "@/lib/comments/validate-body";
import type { CommentActionState } from "@/types";

/**
 * Comments & Mentions Stage 3 (docs/comments-architecture.md §5) — thin
 * wrappers only. Every real decision (rate limiting, target/org scoping,
 * body validation, mention parsing/validation, permissions, Activity/
 * Notification fan-out) lives in the shared src/lib/comments/*.ts helpers;
 * these functions exist solely to bind the Project id, read the plain-text
 * `body` field out of FormData, and translate the shared result into this
 * app's usual `{ error }` action-state shape. No UI reads these yet —
 * Stage 4 wires a real `<form>` to them.
 */
export async function createProjectCommentAction(
  projectId: string,
  _prevState: CommentActionState,
  formData: FormData,
): Promise<CommentActionState> {
  const result = await createCommentForEntity({
    entityType: "PROJECT",
    entityId: projectId,
    rawBody: String(formData.get("body") ?? ""),
  });

  if (!result.ok) {
    return { error: mapCreateError(result.error) };
  }

  revalidatePath(`/projects/${projectId}/edit`);
  return { error: null };
}

export async function editProjectCommentAction(
  projectId: string,
  commentId: string,
  _prevState: CommentActionState,
  formData: FormData,
): Promise<CommentActionState> {
  const result = await editComment({ commentId, rawBody: String(formData.get("body") ?? "") });

  if (!result.ok) {
    return { error: mapEditError(result.error) };
  }

  if (!result.noop) {
    revalidatePath(`/projects/${projectId}/edit`);
  }
  return { error: null };
}

export async function deleteProjectCommentAction(projectId: string, commentId: string): Promise<void> {
  await deleteComment({ commentId });
  revalidatePath(`/projects/${projectId}/edit`);
}

function mapCreateError(error: "rate_limited" | "not_found" | "empty_body" | "body_too_long"): string {
  switch (error) {
    case "rate_limited":
      return RATE_LIMIT_MESSAGE;
    case "not_found":
      return "This project could not be found.";
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
