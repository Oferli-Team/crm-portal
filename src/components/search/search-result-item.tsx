"use client";

import Link from "next/link";
import type { Ref } from "react";
import { SearchHighlight } from "./search-highlight";
import type { FlatSearchResult } from "@/lib/search-ui/flatten-results";

const TYPE_LABEL: Record<FlatSearchResult["type"], string> = {
  CLIENT: "Client",
  PROJECT: "Project",
  TASK: "Task",
  INVOICE: "Invoice",
  COMMENT: "Comment",
};

/**
 * Global Search Stage 3 (docs/search-architecture.md §7/§10). One result
 * row — deliberately a real `<Link>` (not a plain `<div onClick>`), the
 * same "an actual navigable anchor, not a fake one" discipline
 * `NotificationItem` already established: middle-click/right-click/
 * open-in-new-tab all keep working, and reusing `<Link>` reuses Next's own
 * already-proven-correct hash-fragment scroll behavior for a Comment's
 * `#comment-{id}` deep link, rather than a second, hand-rolled navigation
 * path.
 *
 * `tabIndex={-1}` deliberately keeps this anchor out of the Tab order —
 * per docs/search-architecture.md §8/§9, this list uses `aria-
 * activedescendant` on the owning input (see search-results.tsx), not
 * per-item focus; Tab inside the dialog should reach only the input itself
 * (and any dialog-level controls), never cycle through every result row.
 * The anchor is still reachable by mouse click, and `use-global-search.ts`
 * simulates a click on it (via `ref`) to fire Enter-triggered navigation
 * through this exact same, single code path.
 *
 * `url` is always the backend's own already-allowlisted `result-links.ts`
 * output (see src/lib/search/types.ts) — this component never constructs
 * or mutates it.
 */
export function SearchResultItem({
  result,
  query,
  isActive,
  onHover,
  onSelect,
  ref,
}: {
  result: FlatSearchResult;
  query: string;
  isActive: boolean;
  onHover: () => void;
  onSelect: () => void;
  ref?: Ref<HTMLAnchorElement>;
}) {
  return (
    <li id={`global-search-option-${result.flatIndex}`} role="option" aria-selected={isActive}>
      <Link
        ref={ref}
        href={result.url}
        tabIndex={-1}
        prefetch={false}
        onMouseEnter={onHover}
        onClick={onSelect}
        className={`block rounded-md px-3 py-2 transition-colors ${
          isActive ? "bg-gray-100" : "hover:bg-gray-50"
        }`}
      >
        <div className="flex items-baseline justify-between gap-3">
          <p className="min-w-0 truncate text-sm font-medium text-gray-900">
            <SearchHighlight text={result.title} query={query} />
          </p>
          <span className="shrink-0 text-xs font-medium text-gray-400">{TYPE_LABEL[result.type]}</span>
        </div>
        {result.subtitle && <p className="truncate text-xs text-gray-500">{result.subtitle}</p>}
        {result.preview && (
          <p className="mt-0.5 line-clamp-2 text-xs text-gray-600">
            <SearchHighlight text={result.preview} query={query} />
          </p>
        )}
      </Link>
    </li>
  );
}
