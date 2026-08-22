"use client";

import type { KeyboardEvent, Ref } from "react";
import { SearchIcon, SpinnerIcon } from "@/components/ui/icons";

/**
 * Global Search Stage 3 (docs/search-architecture.md §3/§9). A single
 * labeled `<input type="search">` — `aria-label="Search"` directly on the
 * element, the same convention `MentionCombobox`'s own search field
 * already uses (`aria-label="Search teammates to mention"`), rather than a
 * separate `<label htmlFor>` pairing this one-field, label-less-by-design
 * dialog doesn't otherwise need.
 *
 * `role="combobox"` + `aria-expanded`/`aria-controls`/`aria-activedescendant`
 * + `aria-autocomplete="list"` is the lightweight subset of the W3C ARIA
 * combobox pattern docs/search-architecture.md §9 explicitly calls for
 * ("not the full pattern... but semantics must be non-contradictory") —
 * focus never leaves this input (see search-result-item.tsx's own
 * `tabIndex={-1}`), so `aria-activedescendant` is the sole mechanism that
 * tells assistive tech which result is "active."
 *
 * `aria-expanded`/`aria-controls` are driven by `hasListbox`, which the
 * caller (search-dialog.tsx) computes from the exact same condition
 * search-results.tsx uses to decide whether it renders the `id={listboxId}`
 * element at all (`state.flatResults.length > 0`). Idle/loading-with-
 * nothing-cached/no-results/error/rate-limited/unauthorized never render
 * that element, so asserting `aria-expanded="true"` or pointing
 * `aria-controls` at it in those states would be a broken ARIA reference —
 * semantics must never claim a popup exists when it doesn't.
 */
export function SearchInput({
  inputRef,
  value,
  onChange,
  onKeyDown,
  isLoading,
  listboxId,
  hasListbox,
  activeDescendantId,
}: {
  inputRef: Ref<HTMLInputElement>;
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  isLoading: boolean;
  listboxId: string;
  hasListbox: boolean;
  activeDescendantId: string | undefined;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3">
      {isLoading ? (
        <SpinnerIcon className="h-4 w-4 shrink-0 text-gray-400" />
      ) : (
        <SearchIcon className="h-4 w-4 shrink-0 text-gray-400" />
      )}
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={hasListbox}
        aria-controls={hasListbox ? listboxId : undefined}
        aria-activedescendant={activeDescendantId}
        aria-autocomplete="list"
        aria-label="Search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search clients, projects, tasks, invoices, comments…"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="w-full border-none bg-transparent text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-0"
      />
    </div>
  );
}
