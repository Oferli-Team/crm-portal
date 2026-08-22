"use client";

import { useMemo, type ReactNode, type RefObject } from "react";
import { SearchResultGroupSection } from "./search-result-group";
import { SEARCH_UNAUTHORIZED_MESSAGE, SEARCH_GENERIC_ERROR_MESSAGE } from "@/lib/search-ui/response-mapping";
import { groupFlatResults } from "@/lib/search-ui/flatten-results";
import type { GlobalSearchState } from "./use-global-search";

/**
 * Global Search Stage 3 (docs/search-architecture.md §3/§6). Renders every
 * documented state: Initial (idle), Loading, Results (grouped, fixed
 * order), No results, Error, and Rate limited. "Loading" is deliberately
 * NOT a separate branch that blanks the list — `use-global-search.ts`
 * never clears `flatResults` while merely re-fetching (only on an actual
 * settled outcome), so a still-in-flight request naturally keeps the
 * previous result set on screen here; the small spinner that accompanies
 * it lives in search-input.tsx, right next to the field the user is still
 * typing in, not inside this results area.
 */
export function SearchResults({
  state,
  listboxId,
  onHover,
  onSelect,
  itemRefs,
}: {
  state: GlobalSearchState;
  listboxId: string;
  onHover: (flatIndex: number) => void;
  onSelect: () => void;
  itemRefs: RefObject<Map<number, HTMLAnchorElement | null>>;
}) {
  const totalResults = state.flatResults.length;
  // Memoized on `state.groups` specifically (not `state` as a whole) so a
  // re-render caused only by `activeIndex` changing (every ArrowUp/
  // ArrowDown keystroke) reuses the same grouped array instead of
  // re-walking the result set on every keystroke.
  const groupedResults = useMemo(() => groupFlatResults(state.groups), [state.groups]);
  let liveMessage = "";
  let body: ReactNode;

  if (state.phase === "idle") {
    body = (
      <p className="px-3 py-8 text-center text-sm text-gray-500">
        Search clients, projects, tasks, invoices, and comments.
      </p>
    );
  } else if (state.phase === "unauthorized") {
    liveMessage = SEARCH_UNAUTHORIZED_MESSAGE;
    body = <p className="px-3 py-8 text-center text-sm text-gray-500">{SEARCH_UNAUTHORIZED_MESSAGE}</p>;
  } else if (state.phase === "rate_limited") {
    liveMessage = state.message ?? "";
    body = <p className="px-3 py-8 text-center text-sm text-gray-500">{state.message}</p>;
  } else if (state.phase === "error") {
    liveMessage = SEARCH_GENERIC_ERROR_MESSAGE;
    body = <p className="px-3 py-8 text-center text-sm text-gray-500">{SEARCH_GENERIC_ERROR_MESSAGE}</p>;
  } else if (totalResults > 0) {
    // Covers both a settled "results" phase AND "loading" while a fresh
    // query's request is still in flight but the previous result set is
    // still the most recent thing we actually know.
    liveMessage = `${totalResults} result${totalResults === 1 ? "" : "s"}`;
    const sections = groupedResults.map((group) => (
      <SearchResultGroupSection
        key={group.type}
        type={group.type}
        items={group.items}
        query={state.query}
        activeIndex={state.activeIndex}
        onHover={onHover}
        onSelect={onSelect}
        itemRefs={itemRefs}
      />
    ));
    body = (
      <div id={listboxId} role="listbox" aria-label="Search results" className="max-h-96 overflow-y-auto py-1">
        {sections}
      </div>
    );
  } else if (state.phase === "loading") {
    liveMessage = "Searching…";
    body = <p className="px-3 py-8 text-center text-sm text-gray-500">Searching…</p>;
  } else {
    liveMessage = "No results found.";
    body = <p className="px-3 py-8 text-center text-sm text-gray-500">No results found.</p>;
  }

  return (
    <div>
      {body}
      <p className="sr-only" role="status" aria-live="polite">
        {liveMessage}
      </p>
    </div>
  );
}
