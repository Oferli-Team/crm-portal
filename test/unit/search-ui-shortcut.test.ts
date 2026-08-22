import { describe, expect, it } from "vitest";
import { isSearchShortcut, isEditableTarget, shouldHandleSearchShortcut } from "@/lib/search-ui/shortcut";

const NO_SHIFT_ALT = { shiftKey: false, altKey: false };

describe("isSearchShortcut", () => {
  it("recognizes Cmd+K (macOS)", () => {
    expect(isSearchShortcut({ key: "k", metaKey: true, ctrlKey: false, ...NO_SHIFT_ALT })).toBe(true);
  });

  it("recognizes Ctrl+K (Windows/Linux)", () => {
    expect(isSearchShortcut({ key: "k", metaKey: false, ctrlKey: true, ...NO_SHIFT_ALT })).toBe(true);
  });

  it("is case-insensitive on the key itself, independent of modifier state (a real Shift+K keypress reports key: 'K')", () => {
    expect(isSearchShortcut({ key: "K", metaKey: true, ctrlKey: false, ...NO_SHIFT_ALT })).toBe(true);
  });

  it("is not triggered by K alone, with neither modifier", () => {
    expect(isSearchShortcut({ key: "k", metaKey: false, ctrlKey: false, ...NO_SHIFT_ALT })).toBe(false);
  });

  it("is not triggered by Cmd/Ctrl plus a different key", () => {
    expect(isSearchShortcut({ key: "p", metaKey: true, ctrlKey: false, ...NO_SHIFT_ALT })).toBe(false);
    expect(isSearchShortcut({ key: "j", metaKey: false, ctrlKey: true, ...NO_SHIFT_ALT })).toBe(false);
  });
});

describe("isSearchShortcut — Shift/Alt modifier guard", () => {
  it("Cmd+Shift+K is excluded (shadows real OS/browser bindings elsewhere)", () => {
    expect(isSearchShortcut({ key: "K", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false })).toBe(false);
  });

  it("Ctrl+Shift+K is excluded", () => {
    expect(isSearchShortcut({ key: "K", metaKey: false, ctrlKey: true, shiftKey: true, altKey: false })).toBe(false);
  });

  it("Cmd+Alt+K is excluded", () => {
    expect(isSearchShortcut({ key: "k", metaKey: true, ctrlKey: false, shiftKey: false, altKey: true })).toBe(false);
  });

  it("Ctrl+Alt+K is excluded", () => {
    expect(isSearchShortcut({ key: "k", metaKey: false, ctrlKey: true, shiftKey: false, altKey: true })).toBe(false);
  });

  it("Cmd+Shift+Alt+K is excluded (both extra modifiers held at once)", () => {
    expect(isSearchShortcut({ key: "k", metaKey: true, ctrlKey: false, shiftKey: true, altKey: true })).toBe(false);
  });

  it("Ctrl+Shift+Alt+K is excluded", () => {
    expect(isSearchShortcut({ key: "k", metaKey: false, ctrlKey: true, shiftKey: true, altKey: true })).toBe(false);
  });

  it("Shift+K alone (no Cmd/Ctrl) is excluded, same as any other unmodified-by-Cmd/Ctrl key", () => {
    expect(isSearchShortcut({ key: "K", metaKey: false, ctrlKey: false, shiftKey: true, altKey: false })).toBe(false);
  });

  it("Alt+K alone (no Cmd/Ctrl) is excluded", () => {
    expect(isSearchShortcut({ key: "k", metaKey: false, ctrlKey: false, shiftKey: false, altKey: true })).toBe(false);
  });

  it("still recognizes plain Cmd+K and Ctrl+K once Shift/Alt are explicitly false", () => {
    expect(isSearchShortcut({ key: "k", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })).toBe(true);
    expect(isSearchShortcut({ key: "k", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false })).toBe(true);
  });
});

describe("isEditableTarget", () => {
  it("true for an <input>", () => {
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
  });

  it("true for a <textarea>", () => {
    expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
  });

  it("true for a contenteditable element", () => {
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("false for a plain, non-editable element", () => {
    expect(isEditableTarget({ tagName: "DIV" })).toBe(false);
    expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false);
  });

  it("false for null/undefined", () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
  });
});

describe("shouldHandleSearchShortcut", () => {
  it("ignores the shortcut when the dialog is closed and the target is an editable element elsewhere on the page (e.g. a Task title field)", () => {
    expect(shouldHandleSearchShortcut({ tagName: "INPUT" }, false)).toBe(false);
    expect(shouldHandleSearchShortcut({ tagName: "TEXTAREA" }, false)).toBe(false);
    expect(shouldHandleSearchShortcut({ tagName: "DIV", isContentEditable: true }, false)).toBe(false);
  });

  it("handles the shortcut when the dialog is closed and the target is not editable", () => {
    expect(shouldHandleSearchShortcut({ tagName: "BODY" }, false)).toBe(true);
    expect(shouldHandleSearchShortcut({ tagName: "BUTTON" }, false)).toBe(true);
  });

  it("always handles the shortcut while the dialog is already open — the exception for the search input itself, decided by dialog-open state rather than DOM node identity", () => {
    expect(shouldHandleSearchShortcut({ tagName: "INPUT" }, true)).toBe(true);
    expect(shouldHandleSearchShortcut({ tagName: "TEXTAREA" }, true)).toBe(true);
    expect(shouldHandleSearchShortcut(null, true)).toBe(true);
  });
});
