import type { SearchResultType } from "./types";

/**
 * Global Search Stage 2 (docs/search-architecture.md §10). Every link a
 * search result ever carries is built here, from an allowlisted per-type
 * path template — never from a raw/stored URL, never string-concatenated
 * from anything client-supplied. Mirrors `resolveNotificationLinkPath`'s own
 * "allowlisted per type, never built from arbitrary metadata" discipline
 * exactly.
 *
 * Every one of these destination routes already independently re-verifies
 * organization ownership on load (confirmed for Project/Task during the
 * Comments & Mentions engagement's own audit — a cross-org id renders
 * "Page not found") — this module is a display-routing convenience, never
 * itself the authorization boundary.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function buildClientResultUrl(id: string): string | null {
  return isValidUuid(id) ? `/clients/${id}/edit` : null;
}

export function buildProjectResultUrl(id: string): string | null {
  return isValidUuid(id) ? `/projects/${id}/edit` : null;
}

export function buildTaskResultUrl(id: string): string | null {
  return isValidUuid(id) ? `/tasks/${id}/edit` : null;
}

export function buildInvoiceResultUrl(id: string): string | null {
  return isValidUuid(id) ? `/invoices/${id}/edit` : null;
}

export type CommentParentType = "PROJECT" | "TASK";

const COMMENT_PARENT_ROUTES: Record<CommentParentType, string> = {
  PROJECT: "projects",
  TASK: "tasks",
};

/**
 * Reuses the exact deep-link shape Comments & Mentions Stage 4 already
 * built and already verified correct in production
 * (`/projects/{id}/edit#comment-{id}` / `/tasks/{id}/edit#comment-{id}`).
 * Returns null — never a partially-built or guessed URL — for an
 * unrecognized parent type or either id failing UUID validation; the
 * caller (search-comments.ts) must drop the result entirely rather than
 * ever surface a comment with no safe link (see docs/search-architecture.md
 * §13's "invalid/missing parent: result not returned").
 */
export function buildCommentResultUrl(
  parentType: string,
  parentId: string,
  commentId: string,
): string | null {
  if (!isValidUuid(parentId) || !isValidUuid(commentId)) return null;
  const routeSegment = COMMENT_PARENT_ROUTES[parentType as CommentParentType];
  if (!routeSegment) return null;
  return `/${routeSegment}/${parentId}/edit#comment-${commentId}`;
}

/** Defensive dispatcher — not currently called by any search-*.ts (each already knows its own type), kept for a future single call site if one ever needs it. */
export function buildResultUrl(
  type: SearchResultType,
  id: string,
  comment?: { parentType: string; parentId: string },
): string | null {
  switch (type) {
    case "CLIENT":
      return buildClientResultUrl(id);
    case "PROJECT":
      return buildProjectResultUrl(id);
    case "TASK":
      return buildTaskResultUrl(id);
    case "INVOICE":
      return buildInvoiceResultUrl(id);
    case "COMMENT":
      return comment ? buildCommentResultUrl(comment.parentType, comment.parentId, id) : null;
    default:
      return null;
  }
}
