import { SearchResultItem } from "./search-result-item";
import { flatResultKey, type FlatSearchResult } from "@/lib/search-ui/flatten-results";
import type { SearchResultType } from "@/lib/search/types";

const GROUP_LABEL: Record<SearchResultType, string> = {
  CLIENT: "Clients",
  PROJECT: "Projects",
  TASK: "Tasks",
  INVOICE: "Invoices",
  COMMENT: "Comments",
};

/**
 * Global Search Stage 3 (docs/search-architecture.md §3, "Grouping" —
 * "empty groups can be hidden... groups themselves are always shown in
 * this fixed order"). The backend already returns groups in the fixed
 * CLIENT/PROJECT/TASK/INVOICE/COMMENT order (search.ts); the parent
 * (search-results.tsx) renders one of these sections per group, in that
 * exact order, unchanged — this component only decides whether to render
 * a given group at all (skipped when empty).
 *
 * `items` are already the flattened, globally-indexed slice belonging to
 * this one group (see search-results.tsx's own offset-slicing) — never
 * re-derived or re-ordered here, so there is exactly one place
 * (flatten-results.ts) that decides flatIndex values.
 */
export function SearchResultGroupSection({
  type,
  items,
  query,
  activeIndex,
  onHover,
  onSelect,
  itemRefs,
}: {
  type: SearchResultType;
  items: FlatSearchResult[];
  query: string;
  activeIndex: number;
  onHover: (flatIndex: number) => void;
  onSelect: () => void;
  itemRefs: React.RefObject<Map<number, HTMLAnchorElement | null>>;
}) {
  if (items.length === 0) return null;

  return (
    <div role="group" aria-label={GROUP_LABEL[type]}>
      <p className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-gray-400 uppercase">
        {GROUP_LABEL[type]}
      </p>
      <ul>
        {items.map((item) => (
          <SearchResultItem
            key={flatResultKey(item)}
            result={item}
            query={query}
            isActive={item.flatIndex === activeIndex}
            onHover={() => onHover(item.flatIndex)}
            onSelect={onSelect}
            ref={(el) => {
              itemRefs.current.set(item.flatIndex, el);
            }}
          />
        ))}
      </ul>
    </div>
  );
}
