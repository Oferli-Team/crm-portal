/**
 * Comments & Mentions Stage 3 (docs/comments-architecture.md §3): validates
 * and normalizes a comment body — nothing else. Deliberately takes only the
 * raw string; organizationId/authorId/recipientIds/mentionUserIds are never
 * parameters here or anywhere in this module — those are resolved
 * server-side by the caller (current-user helpers, Membership queries),
 * never derived from or accepted alongside a request body.
 *
 * No Markdown, no HTML conversion — the normalized body is stored exactly
 * as validated, byte for byte; rendering safety comes from never trusting
 * it as markup (see docs/comments-architecture.md §8), not from anything
 * this function does to the text.
 */

// No firm number exists in the design doc — chosen here as a deliberate,
// documented MVP ceiling: generous enough for a real discussion/status
// update, small enough to keep Activity/Notification metadata previews and
// ordinary page rendering cheap. A validation constant, not a schema
// constraint (Comment.body is unbounded `text`, see prisma/schema.prisma) —
// raising or lowering this later needs no migration.
export const COMMENT_BODY_MAX_LENGTH = 10_000;

export type CommentBodyValidationResult =
  | { ok: true; body: string }
  | { ok: false; error: "empty" | "too_long" };

// The single NUL control character, built at runtime from its numeric code
// point rather than written as an escape sequence in this file's own
// source text.
const NUL_CHARACTER = String.fromCharCode(0);

/**
 * Postgres text columns cannot store an embedded NUL control character at
 * all (a real database limitation, not a security sanitization) — removed
 * so a comment containing one fails to render strangely rather than
 * failing to save with a raw driver error. CRLF/lone CR are normalized to
 * a plain newline for consistent storage — this only changes line-ending
 * bytes, never removes or reorders any other character, so a mention
 * token's exact "at-bracket-name-bracket-paren-user-colon-uuid-paren"
 * substring is never altered or cut by this pass regardless of where it
 * appears in the body.
 */
function normalizeControlCharacters(value: string): string {
  return value.split(NUL_CHARACTER).join("").replace(/\r\n?/g, "\n");
}

/**
 * Trims leading/trailing whitespace only — never touches internal
 * whitespace, so mention tokens and ordinary formatting inside the body
 * are untouched. Rejects empty-after-trim and over-length input; accepts
 * everything else as plain text, unconditionally (a script tag typed as
 * text is valid content here — it is simply never rendered as markup by
 * anything downstream, see docs/comments-architecture.md §8).
 */
export function validateCommentBody(raw: unknown): CommentBodyValidationResult {
  const asString = typeof raw === "string" ? raw : "";
  const normalized = normalizeControlCharacters(asString);
  const trimmed = normalized.trim();

  if (trimmed.length === 0) {
    return { ok: false, error: "empty" };
  }
  if (trimmed.length > COMMENT_BODY_MAX_LENGTH) {
    return { ok: false, error: "too_long" };
  }

  return { ok: true, body: trimmed };
}
