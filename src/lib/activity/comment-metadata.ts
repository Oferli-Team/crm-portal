/**
 * Comments & Mentions Stage 3 (docs/comments-architecture.md §9). Every
 * shape here is an explicit, small allowlist — never the full comment
 * body verbatim (only a bounded, whitespace-collapsed preview), never a
 * raw mention token, never a User/Comment/Project/Task/Organization id,
 * never an email or internal note. Mirrors the discipline every other
 * *-metadata.ts builder in this app already follows (see
 * attachment-metadata.ts's own header comment).
 */

export type CommentCreatedActivityMetadata = {
  parentEntityType: string;
  parentEntityLabel: string;
  actorName: string;
  commentPreview: string;
  mentionCount: number;
};

export function buildCommentCreatedMetadata(params: {
  parentEntityType: string;
  parentEntityLabel: string;
  actorName: string;
  commentPreview: string;
  mentionCount: number;
}): CommentCreatedActivityMetadata {
  return { ...params };
}

export type CommentUpdatedActivityMetadata = {
  parentEntityType: string;
  parentEntityLabel: string;
  actorName: string;
  commentPreview: string;
  mentionCount: number;
  addedMentionCount: number;
  removedMentionCount: number;
};

export function buildCommentUpdatedMetadata(params: {
  parentEntityType: string;
  parentEntityLabel: string;
  actorName: string;
  commentPreview: string;
  mentionCount: number;
  addedMentionCount: number;
  removedMentionCount: number;
}): CommentUpdatedActivityMetadata {
  return { ...params };
}

export type CommentDeletedActivityMetadata = {
  parentEntityType: string;
  parentEntityLabel: string;
  actorName: string;
  authorName: string;
  /** True when the actor deleting this comment isn't its own author — an OWNER/ADMIN moderation delete rather than a self-delete. */
  moderated: boolean;
};

export function buildCommentDeletedMetadata(params: {
  parentEntityType: string;
  parentEntityLabel: string;
  actorName: string;
  authorName: string;
  moderated: boolean;
}): CommentDeletedActivityMetadata {
  return { ...params };
}
