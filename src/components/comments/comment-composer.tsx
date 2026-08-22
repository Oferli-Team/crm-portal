"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FormLabel } from "@/components/ui/form-field";
import { MentionCombobox } from "./mention-combobox";
import { buildMentionToken } from "@/lib/comments/mentions";
import { COMMENT_BODY_MAX_LENGTH } from "@/lib/comments/validate-body";
import type { MentionCandidate } from "@/lib/comments/mention-candidates";
import type { CommentActionState } from "@/types";

const initialState: CommentActionState = { error: null };

/**
 * Comments & Mentions Stage 4 (docs/comments-architecture.md §4/§6/§7) — the
 * one composer, reused for both "new comment" and "edit this comment"
 * (docs/comments-architecture.md's own §7 explicitly calls this out: "the
 * same composer textarea", not a second form). Plain multi-line textarea +
 * submit button + useActionState, identical shape to every other form in
 * this app; server-side validation (src/lib/comments/validate-body.ts)
 * remains the actual source of truth — the displayed character count and
 * native `maxLength` are UX conveniences only, not authorization.
 *
 * The textarea is intentionally uncontrolled (defaultValue, not value) —
 * consistent with every other form in this app — so the mention picker
 * inserts its token directly into the DOM node via a ref rather than
 * fighting React state for every keystroke; only the displayed character
 * count is tracked in React state, and only because it needs to react to
 * typing at all.
 */
export function CommentComposer({
  action,
  candidates,
  initialBody = "",
  submitLabel = "Post comment",
  pendingLabel = "Posting…",
  cancelLabel = "Cancel",
  onCancel,
  onSuccess,
  autoFocus = false,
}: {
  action: (prevState: CommentActionState, formData: FormData) => Promise<CommentActionState>;
  candidates: MentionCandidate[];
  initialBody?: string;
  submitLabel?: string;
  pendingLabel?: string;
  cancelLabel?: string;
  /** Rendering a Cancel button (edit mode) also means "don't clear the form on success" — the parent unmounts this composer instead. */
  onCancel?: () => void;
  onSuccess?: () => void;
  autoFocus?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const wasPending = useRef(false);
  const [length, setLength] = useState(initialBody.length);
  // Unique per composer instance — this component renders more than once
  // at a time on a page (the top-level composer plus any comment
  // currently being edited inline), so a fixed literal id would produce
  // duplicate ids/duplicate-labeled fields in the same document.
  const bodyFieldId = useId();

  useEffect(() => {
    if (wasPending.current && !pending && state.error === null) {
      if (!onCancel) {
        formRef.current?.reset();
        // Routes the length update through the textarea's own onChange
        // handler (a real event, not a setState call inside this effect
        // body) — .reset() doesn't fire a native input/change event on
        // its own.
        textareaRef.current?.dispatchEvent(new Event("input", { bubbles: true }));
      }
      onSuccess?.();
    }
    wasPending.current = pending;
  }, [pending, state, onCancel, onSuccess]);

  function insertMention(candidate: MentionCandidate) {
    const el = textareaRef.current;
    if (!el) return;
    const token = buildMentionToken(candidate.name, candidate.id);
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const leadingSpace = before.length > 0 && !/\s$/.test(before) ? " " : "";
    const trailingSpace = after.length > 0 && !/^\s/.test(after) ? " " : "";
    const insertText = `${leadingSpace}${token}${trailingSpace}`;

    el.value = before + insertText + after;
    const cursor = (before + insertText).length;
    el.setSelectionRange(cursor, cursor);
    el.focus();
    setLength(el.value.length);
  }

  return (
    <form ref={formRef} action={formAction} className="space-y-2">
      <FormLabel htmlFor={bodyFieldId}>Comment</FormLabel>
      <Textarea
        ref={textareaRef}
        id={bodyFieldId}
        name="body"
        rows={3}
        defaultValue={initialBody}
        maxLength={COMMENT_BODY_MAX_LENGTH}
        required
        autoFocus={autoFocus}
        onChange={(event) => setLength(event.target.value.length)}
        aria-invalid={!!state.error}
        aria-describedby={`${bodyFieldId}-char-count${state.error ? ` ${bodyFieldId}-error` : ""}`}
      />

      <div className="flex items-center justify-between gap-3">
        <MentionCombobox candidates={candidates} onSelect={insertMention} />
        <p id={`${bodyFieldId}-char-count`} className="shrink-0 text-xs text-gray-500">
          {length} / {COMMENT_BODY_MAX_LENGTH}
        </p>
      </div>

      {state.error && (
        <p id={`${bodyFieldId}-error`} role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" loading={pending}>
          {pending ? pendingLabel : submitLabel}
        </Button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {cancelLabel}
          </button>
        )}
      </div>
    </form>
  );
}
