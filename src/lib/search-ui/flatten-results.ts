import type { SearchResult, SearchResultGroup } from "@/lib/search/types";

/**
 * Global Search Stage 3 (docs/search-architecture.md §3, "Keyboard
 * navigation" — "Up/Down moves a single active index across the
 * *flattened* result list"). The backend's own group order (CLIENT,
 * PROJECT, TASK, INVOICE, COMMENT — see search.ts) is preserved exactly;
 * this module only flattens it for keyboard traversal, it never
 * re-sorts, re-filters, or otherwise duplicates the backend's own ranking
 * logic (docs/search-architecture.md §5's "never re-implement ranking
 * client-side").
 */
export type FlatSearchResult = SearchResult & {
  /** Position in the flattened list — a stable, deterministic index across renders of the same response. */
  flatIndex: number;
};

/**
 * Trusts each item's own already-correct `type` field (set by the backend
 * — see search.ts, every item in a group is guaranteed that group's own
 * type) rather than re-stamping it from the group here, so there is only
 * ever one source of truth for a result's type.
 */
export function flattenSearchGroups(groups: readonly SearchResultGroup[]): FlatSearchResult[] {
  const flat: FlatSearchResult[] = [];
  let index = 0;
  for (const group of groups) {
    for (const item of group.items) {
      flat.push({ ...item, flatIndex: index });
      index += 1;
    }
  }
  return flat;
}

/** A stable React key for a flattened result — `type` is included because a Comment's id and a Client's id are drawn from the same UUID space and could theoretically collide. */
export function flatResultKey(result: Pick<FlatSearchResult, "type" | "id">): string {
  return `${result.type}:${result.id}`;
}

export type FlatResultGroup = { type: SearchResultGroup["type"]; items: FlatSearchResult[] };

/**
 * Re-buckets `flattenSearchGroups`'s own output back into per-type
 * sections — lets a rendering component (search-results.tsx) render one
 * section per group with no offset bookkeeping of its own. Deliberately
 * built on top of `flattenSearchGroups` rather than a second, independent
 * index-walk: `flatIndex` assignment has exactly one implementation, so a
 * flat item's index (used for keyboard navigation) and a grouped item's
 * index (used for rendering `id`/`aria-activedescendant`) can never drift
 * apart. Slicing by `group.items.length` is safe because
 * `flattenSearchGroups` visits groups/items in the same order this `map`
 * does.
 */
export function groupFlatResults(groups: readonly SearchResultGroup[]): FlatResultGroup[] {
  const flat = flattenSearchGroups(groups);
  let cursor = 0;
  return groups.map((group) => {
    const items = flat.slice(cursor, cursor + group.items.length);
    cursor += group.items.length;
    return { type: group.type, items };
  });
}

/**
 * Clamps an index into `[0, length - 1]`, or -1 for an empty list —
 * used whenever the underlying result set changes size (a fresh
 * response arrives) and a previously-active index might now point past
 * the end of a shorter list, or into an empty one.
 */
export function clampActiveIndex(index: number, length: number): number {
  if (length <= 0) return -1;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}

export type NavigationDirection = 1 | -1;

/**
 * Wraps at both ends (ArrowDown past the last result returns to the
 * first, ArrowUp past the first returns to the last) — the same
 * power-user convention command palettes like this app's own "type a
 * few characters, arrow to the right one, Enter" workflow already
 * assumes elsewhere (e.g. <select> native wrap behavior). Starting from
 * "no selection" (-1), the first press always lands on a real result
 * (index 0 for ArrowDown, the last item for ArrowUp) rather than on an
 * off-by-one edge.
 */
export function nextActiveIndex(current: number, length: number, direction: NavigationDirection): number {
  if (length <= 0) return -1;
  if (current < 0) return direction === 1 ? 0 : length - 1;
  return (current + direction + length) % length;
}
