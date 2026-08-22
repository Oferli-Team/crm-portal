/**
 * Global Search Stage 3 (docs/search-architecture.md §3, "Cmd+K / Ctrl+K").
 * Pure, DOM-free predicates — deliberately typed against small duck-typed
 * shapes rather than real DOM interfaces (`KeyboardEvent`, `HTMLElement`)
 * so they stay unit-testable in this project's Node-only unit test
 * environment (no jsdom/browser globals — see vitest.config.mts). The real
 * `KeyboardEvent`/`EventTarget` a browser hands the actual listener already
 * structurally satisfy these shapes, so no adapter is needed at the call
 * site either.
 */

export type ShortcutKeyEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

/**
 * True for exactly Cmd+K (macOS) or Ctrl+K (Windows/Linux) — never both
 * required at once. Shift or Alt held alongside either modifier is
 * deliberately excluded: Cmd+Shift+K/Ctrl+Shift+K and Cmd+Alt+K/Ctrl+Alt+K
 * are real OS/browser bindings elsewhere (e.g. "reopen closed tab",
 * DevTools panels) this shortcut must never shadow.
 */
export function isSearchShortcut(event: ShortcutKeyEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "k"
  );
}

export type EditableTargetLike = { tagName?: string; isContentEditable?: boolean } | null | undefined;

/** True for a text `<input>`, a `<textarea>`, or any contenteditable element — the set of elements a global shortcut must never hijack keystrokes away from while the user is typing into them. */
export function isEditableTarget(target: EditableTargetLike): boolean {
  if (!target) return false;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return true;
  return Boolean(target.isContentEditable);
}

/**
 * The one exception to `isEditableTarget`'s own rule: while the search
 * dialog is already open, Cmd/Ctrl+K must still work (as the documented
 * toggle-to-close behavior — see global-search.tsx) even though the
 * dialog's own `<input>` is itself focused and would otherwise match
 * `isEditableTarget`. Deliberately keyed on "is our dialog open" rather
 * than comparing the event target against a specific input DOM node —
 * this needs no ref-identity check at all, and stays correct even if the
 * dialog's internal markup changes shape later. Every *other* editable
 * element on the page (a Task title field, a Comment composer, a Client
 * notes textarea, ...) is only ever reachable while the dialog is closed,
 * so `dialogIsOpen` alone is a complete, unambiguous signal.
 */
export function shouldHandleSearchShortcut(target: EditableTargetLike, dialogIsOpen: boolean): boolean {
  if (dialogIsOpen) return true;
  return !isEditableTarget(target);
}
