/**
 * Global Search Stage 2 (docs/search-architecture.md §5). Ranking is
 * computed independently per entity type — never a cross-type score (see
 * the design doc's own reasoning: a single merged ranking would need a
 * UNION-shaped query across five different tables, meaningfully harder to
 * build/test than five independent bounded queries for a marginal UX gain
 * in a small, keyword-navigated dropdown).
 *
 * Pure, deterministic, unit-testable in isolation from any database: every
 * function here operates on already-fetched candidate rows (a bounded
 * per-type set — see search.ts), never queries anything itself.
 */

/** 1 = exact match (best), 4 = secondary-field contains (weakest tier that still counts as a match). */
export type MatchTier = 1 | 2 | 3 | 4;

/**
 * Case-insensitive. `primary` is the entity's own title/number
 * (Client.name, Project.name, Task.title, Invoice.invoiceNumber); `secondary`
 * is the one related-entity field the existing per-list search convention
 * already `OR`s in (Project's Client.name, Task's Project.name, Invoice's
 * Project/Client name) — never a third, speculative field. Returns null
 * when nothing matches at all (defensive only: every candidate passed in
 * already matched the DB's own `contains` filter, so this should always
 * find at least tier 3 or 4 in practice).
 */
export function computeMatchTier(params: {
  query: string;
  primary: string;
  secondary?: string | null;
}): MatchTier | null {
  const query = params.query.toLowerCase();
  const primary = params.primary.toLowerCase();

  if (primary === query) return 1;
  if (primary.startsWith(query)) return 2;
  if (primary.includes(query)) return 3;
  if (params.secondary && params.secondary.toLowerCase().includes(query)) return 4;

  return null;
}

export type RankableCandidate = {
  id: string;
  tier: MatchTier | null;
  /**
   * Recency, ISO-8601 — matches this app's own universal keyset tie-break
   * convention (`createdAt DESC, id DESC`, see src/lib/activity/cursor.ts),
   * applied here in-memory instead of in SQL for the same reason ranking
   * itself is in-memory (see search.ts §11).
   */
   recencyKey: string;
};

/**
 * Sorts by tier ascending (1 = best, first), then by recencyKey descending
 * (newest first), then by id descending — the final id tie-break exists
 * purely so two rows with an identical recencyKey (down to the millisecond)
 * still sort deterministically and stably across repeated calls on the same
 * data, never by insertion order alone. Never mutates the input array.
 */
export function sortRanked<T extends RankableCandidate>(candidates: readonly T[]): T[] {
  return [...candidates]
    .filter((c): c is T & { tier: MatchTier } => c.tier !== null)
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.recencyKey !== b.recencyKey) return a.recencyKey < b.recencyKey ? 1 : -1;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
}
