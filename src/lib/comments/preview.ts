/**
 * Comments & Mentions Stage 3 (docs/comments-architecture.md §5/§6): a
 * deterministic, bounded, plain-text preview of a comment body — used by
 * Activity metadata (commentPreview) and, since Notification metadata is
 * built from Activity metadata, by the Notification/email layer too.
 * Never HTML, never a length that could bloat a metadata JSON blob, and
 * never leaks the mention token's raw `(user:<uuid>)` syntax — that part
 * of the token is stripped, keeping only its display name.
 */
export const COMMENT_PREVIEW_MAX_LENGTH = 140;

/**
 * Same collapsing rule for every whitespace/control character (space, tab,
 * newline, CR, and the C0 control range) — a preview must render as one
 * clean line in a notification/activity row, never with embedded newlines
 * or invisible characters breaking the layout. This does NOT rewrite the
 * stored Comment.body itself (see validate-body.ts) — only the preview.
 */
function collapseWhitespace(value: string): string {
  return value.replace(/[\x00-\x1F\x7F\s]+/g, " ").trim();
}

/** Strips `@[Name](user:uuid)` down to just its display name for the preview — the raw token syntax is never shown to a reader. */
function stripMentionTokensToDisplayNames(value: string): string {
  return value.replace(
    /@\[([^\]\n]{1,100})\]\(user:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\)/g,
    "@$1",
  );
}

/**
 * Pure, never throws. Truncates on a character boundary (not attempting
 * word-boundary truncation — simplicity over polish for an MVP preview
 * string) and appends an ellipsis only when truncation actually happened.
 */
export function buildCommentPreview(
  body: unknown,
  maxLength: number = COMMENT_PREVIEW_MAX_LENGTH,
): string {
  if (typeof body !== "string") return "";

  try {
    const withoutTokens = stripMentionTokensToDisplayNames(body);
    const collapsed = collapseWhitespace(withoutTokens);
    if (collapsed.length <= maxLength) return collapsed;
    return `${collapsed.slice(0, maxLength).trimEnd()}…`;
  } catch {
    return "";
  }
}
