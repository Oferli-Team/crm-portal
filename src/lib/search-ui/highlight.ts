/**
 * Global Search Stage 3 (docs/search-architecture.md §3, "Highlighting").
 * Pure, DOM-free string segmentation — never React's raw-HTML-injection
 * escape hatch, matching this app's absolute rule. The caller (search-
 * highlight.tsx) maps each segment to a plain JSX text node or a `<mark>`,
 * exactly the same "split into safe segments, render as JSX" shape
 * `splitBodyIntoSegments` already established for Comments' own mention
 * rendering.
 *
 * Deliberately never builds a `RegExp` from the query — every match is
 * found via plain `String.prototype.indexOf` on lower-cased copies of both
 * strings, so a query containing regex metacharacters (`.`, `*`, `(`, `[`,
 * `\`, etc.) is always treated as a literal substring, never interpreted.
 * This is also what makes the function trivially safe against the same
 * "%", "_", "\" concerns normalize-query.ts's own `escapeLikePattern`
 * exists for on the backend — those characters have no special meaning to
 * `indexOf` at all, so there is nothing to escape here in the first place.
 */
export type HighlightSegment = { text: string; match: boolean };

/**
 * `text` is rendered verbatim except for byte-for-byte case-insensitive
 * matches of `query`; case is preserved in the *rendered* output (only the
 * comparison is case-folded), matching Postgres's own `mode: "insensitive"`
 * semantics the backend already ranks against. An empty/whitespace-only
 * query, or empty text, degrades to a single non-matching segment (or none
 * at all for empty text) rather than throwing or highlighting everything.
 */
export function buildHighlightSegments(text: string, query: string): HighlightSegment[] {
  if (text.length === 0) return [];

  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    return [{ text, match: false }];
  }

  const lowerText = text.toLowerCase();
  const lowerQuery = trimmedQuery.toLowerCase();

  const segments: HighlightSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const matchIndex = lowerText.indexOf(lowerQuery, cursor);
    if (matchIndex === -1) {
      segments.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (matchIndex > cursor) {
      segments.push({ text: text.slice(cursor, matchIndex), match: false });
    }
    segments.push({ text: text.slice(matchIndex, matchIndex + lowerQuery.length), match: true });
    cursor = matchIndex + lowerQuery.length;
  }

  return segments;
}
