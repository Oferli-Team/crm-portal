/**
 * Global Search Stage 2 (docs/search-architecture.md §3, §8). Pure, never
 * throws — the query is untrusted user input by definition.
 *
 * Below this length there is nothing meaningful to search for and every
 * result would be dominated by noise (see the design doc's §3 "minimum
 * query length" decision) — the route treats this as "no search yet," not
 * an error.
 */
export const SEARCH_QUERY_MIN_LENGTH = 2;

/**
 * The design doc's §3/§8 didn't fix a maximum — decided here, as part of
 * Stage 2's own backend contract: long input is silently truncated rather
 * than rejected with a 400. A live, debounced search box is not a form
 * submission a user consciously reviews before sending — bouncing a
 * accidental long paste with a hard error would be a jarring, confusing
 * failure mode for what should always degrade to "no results" at worst.
 * Truncating still searches the (very likely already-matching) prefix,
 * and every downstream query is bounded by candidate/result limits
 * regardless of input length, so this is a UX choice, not a safety one.
 */
export const SEARCH_QUERY_MAX_LENGTH = 100;

export type NormalizedQuery = { ok: true; value: string } | { ok: false; reason: "too_short" };

/**
 * Strips every Unicode "Control" category code point (`\p{Cc}}` — the C0
 * range including NUL, plus the C1 range), the same class of character
 * `src/lib/comments/validate-body.ts` already strips from comment bodies
 * for the same underlying reason: Postgres's `text` columns cannot store
 * an embedded NUL at all, and a raw one reaching a query would otherwise
 * surface as a database error instead of degrading to "no results" like
 * every other unmatched query does.
 */
function stripControlCharacters(value: string): string {
  return value.replace(/\p{Cc}/gu, "");
}

/**
 * Unicode-normalizes (NFC — composed form, so combining-character variants
 * of the same visible text compare equal), strips control characters,
 * collapses all whitespace (including newlines/tabs) to single spaces, and
 * trims. Truncation happens after collapsing, so the max-length budget is
 * spent on meaningful characters, not run after run of whitespace.
 */
export function normalizeSearchQuery(raw: unknown): NormalizedQuery {
  const asString = typeof raw === "string" ? raw : "";

  let collapsed: string;
  try {
    collapsed = stripControlCharacters(asString.normalize("NFC")).replace(/\s+/g, " ").trim();
  } catch {
    // String.prototype.normalize can throw on some malformed inputs —
    // degrade to "no query" rather than ever propagating an exception.
    return { ok: false, reason: "too_short" };
  }

  const truncated =
    collapsed.length > SEARCH_QUERY_MAX_LENGTH ? collapsed.slice(0, SEARCH_QUERY_MAX_LENGTH) : collapsed;

  if (truncated.length < SEARCH_QUERY_MIN_LENGTH) {
    return { ok: false, reason: "too_short" };
  }

  return { ok: true, value: truncated };
}

/**
 * Escapes Postgres LIKE/ILIKE's three special characters (`%`, `_`, and the
 * escape character `\` itself) so a literal search for e.g. "50%" or
 * "a_b" matches that literal text instead of being interpreted as a
 * wildcard — Prisma's `contains` filter parameterizes the value safely
 * against SQL injection, but does not itself escape LIKE-pattern
 * metacharacters embedded in the value. Must be applied to every raw query
 * string immediately before it reaches a `contains` filter, and to nothing
 * else (never the already-safe values this app puts back into the DOM).
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
