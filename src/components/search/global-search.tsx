"use client";

import { useEffect, useRef } from "react";
import { SearchIcon } from "@/components/ui/icons";
import { SearchDialog, type SearchDialogHandle } from "./search-dialog";
import { isSearchShortcut, shouldHandleSearchShortcut, type EditableTargetLike } from "@/lib/search-ui/shortcut";

/**
 * Global Search Stage 3 (docs/search-architecture.md §3, "Entry points").
 * The one mounted instance of the whole feature: a Header trigger button
 * plus the single global `Cmd+K`/`Ctrl+K` keydown listener docs/search-
 * architecture.md calls for — mounted here (inside the Header, which is
 * itself only ever rendered by `(dashboard)/layout.tsx`, never the portal
 * layout) rather than as a second, separately-mounted component alongside
 * `Sidebar`, since the trigger button and the shortcut both need to act on
 * the exact same dialog instance/handle.
 *
 * A staff-only surface by construction: this component (and therefore the
 * shortcut listener) simply never exists in the React tree the Client
 * Portal renders — there is no flag or runtime check to bypass, the same
 * structural guarantee Comments & Mentions relied on for its own portal
 * exclusion.
 */
export function GlobalSearch() {
  const dialogHandleRef = useRef<SearchDialogHandle>(null);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!isSearchShortcut(event)) return;

      const dialogIsOpen = dialogHandleRef.current?.isOpen() ?? false;
      if (!shouldHandleSearchShortcut(event.target as EditableTargetLike, dialogIsOpen)) {
        return;
      }

      // Stops the browser's own address-bar-focus shortcut from firing
      // alongside ours.
      event.preventDefault();

      if (dialogIsOpen) {
        dialogHandleRef.current?.close();
      } else {
        dialogHandleRef.current?.open();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <>
      <button
        type="button"
        aria-label="Search (Cmd+K)"
        onClick={() => dialogHandleRef.current?.open()}
        className="flex items-center gap-2 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-500 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
      >
        <SearchIcon className="h-4 w-4 shrink-0" />
        <span className="hidden sm:inline">Search…</span>
        <kbd className="hidden shrink-0 rounded border border-gray-300 bg-gray-50 px-1.5 py-0.5 font-sans text-xs text-gray-400 sm:inline">
          ⌘K
        </kbd>
      </button>
      <SearchDialog ref={dialogHandleRef} />
    </>
  );
}
