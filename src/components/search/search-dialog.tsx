"use client";

import { useId, useImperativeHandle, useRef, type KeyboardEvent, type Ref } from "react";
import { SearchInput } from "./search-input";
import { SearchResults } from "./search-results";
import { useGlobalSearch } from "./use-global-search";

export type SearchDialogHandle = {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
};

/**
 * Global Search Stage 3 (docs/search-architecture.md §3, "The dialog").
 * A native `<dialog>` — matching `ConfirmDialog` exactly: free focus trap,
 * free Escape-to-close, free backdrop-click-to-close, and free return-
 * focus-to-invoker on close (the HTML spec has `showModal()` remember
 * whatever element was focused beforehand and refocus it once the dialog
 * closes — no manual ref-passing needed for that part).
 *
 * `useGlobalSearch`'s state is reset on every close (`onClose`, the native
 * `close` DOM event React exposes for `<dialog>`) — whether the user
 * pressed Escape, clicked the backdrop, or selected a result — so a
 * re-opened dialog always starts from the neutral empty state, never a
 * stale query or stale result set from whatever was last searched.
 *
 * A switch to a different organization is handled independently of that:
 * `<dialog>` is modal (`showModal()`), which makes the rest of the document
 * — including the organization switcher — inert while this is open, so an
 * org switch cannot even begin mid-search. As defense-in-depth against that
 * assumption ever changing, header.tsx also mounts `<GlobalSearch
 * key={activeOrganizationId}>` — React fully unmounts and remounts this
 * whole subtree (discarding all `useGlobalSearch` state) whenever the
 * active organization id changes, independent of whether the dialog
 * happened to be open at the time.
 */
export function SearchDialog({ ref }: { ref?: Ref<SearchDialogHandle> }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<number, HTMLAnchorElement | null>>(new Map());
  const titleId = useId();
  const listboxId = useId();

  const { state, setQuery, reset, moveActive, setActiveByHover } = useGlobalSearch();

  useImperativeHandle(ref, () => ({
    open: () => {
      dialogRef.current?.showModal();
      // showModal() itself doesn't move focus into the dialog's own
      // content on every browser — explicitly focusing the input matches
      // docs/search-architecture.md §3's "autofocused on open" and is
      // harmless where the browser already did it.
      inputRef.current?.focus();
    },
    close: () => dialogRef.current?.close(),
    isOpen: () => dialogRef.current?.open ?? false,
  }));

  function selectActiveResult() {
    const el = itemRefs.current.get(state.activeIndex);
    // Simulates a genuine click on the real <Link>-rendered <a> (see
    // search-result-item.tsx) — reuses that exact same navigation path
    // (including Next's own hash-fragment scroll handling for a Comment's
    // #comment-{id} deep link) rather than a second, hand-rolled
    // `router.push` call.
    el?.click();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (state.activeIndex >= 0) {
        selectActiveResult();
      }
    }
    // Escape is deliberately never handled here — it must reach the
    // native <dialog>'s own cancel/close handling unimpeded.
  }

  const activeResult = state.flatResults[state.activeIndex];
  const activeDescendantId = activeResult ? `global-search-option-${activeResult.flatIndex}` : undefined;
  // Matches search-results.tsx's own condition for rendering the
  // `id={listboxId}` element exactly — the single source of truth for
  // whether a listbox actually exists in the DOM right now.
  const hasListbox = state.flatResults.length > 0;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={reset}
      onClick={(event) => {
        if (event.target === dialogRef.current) {
          dialogRef.current?.close();
        }
      }}
      className="w-full max-w-lg rounded-lg border border-gray-200 bg-white p-0 shadow-xl backdrop:bg-black/40"
    >
      <h2 id={titleId} className="sr-only">
        Search
      </h2>
      <SearchInput
        inputRef={inputRef}
        value={state.query}
        onChange={setQuery}
        onKeyDown={handleKeyDown}
        isLoading={state.phase === "loading"}
        listboxId={listboxId}
        hasListbox={hasListbox}
        activeDescendantId={activeDescendantId}
      />
      <SearchResults
        state={state}
        listboxId={listboxId}
        onHover={setActiveByHover}
        onSelect={() => {
          // Deferred a tick, same reasoning as NotificationBell's own
          // close(): the click that just fired is the <Link>'s own
          // navigation-triggering click, still bubbling through this same
          // DOM tree — closing (and thereby resetting) the dialog
          // synchronously in that same tick risks racing Next's own
          // navigation start. Letting it finish first, then closing,
          // avoids that race entirely.
          setTimeout(() => dialogRef.current?.close(), 0);
        }}
        itemRefs={itemRefs}
      />
    </dialog>
  );
}
