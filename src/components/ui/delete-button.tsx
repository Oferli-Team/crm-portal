"use client";

import { useRef, useState } from "react";
import { TrashIcon } from "@/components/ui/icons";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/toast/toast-provider";

/** A void-returning action's success is unconditional (every existing caller); a result-aware action can report a controlled failure instead of throwing (Invoice's DRAFT-only guard, e.g.). */
export type DeleteButtonActionResult = void | { ok: boolean };

export function DeleteButton({
  action,
  itemName,
  confirmTitle,
  confirmDescription,
  successMessage,
  conflictMessage = `Failed to delete ${itemName}.`,
}: {
  /** A bound, zero-argument server action (e.g. deleteClientAction.bind(null, id)). May resolve void (existing behavior, unconditional success) or { ok: boolean } (a controlled guard result). */
  action: () => Promise<DeleteButtonActionResult>;
  itemName: string;
  confirmTitle: string;
  confirmDescription: string;
  successMessage: string;
  /** Shown instead of successMessage when a result-aware action resolves { ok: false }. Defaults to the same generic text the catch branch already used. */
  conflictMessage?: string;
}) {
  const dialogRef = useRef<ConfirmDialogHandle>(null);
  const { showToast } = useToast();
  const [pending, setPending] = useState(false);

  async function handleConfirm() {
    setPending(true);
    try {
      const result = await action();
      if (result && "ok" in result && !result.ok) {
        showToast(conflictMessage, "error");
      } else {
        showToast(successMessage);
      }
    } catch {
      showToast(`Failed to delete ${itemName}.`, "error");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={() => dialogRef.current?.open()}
        className="inline-flex items-center gap-1 rounded text-sm font-medium text-red-600 transition-colors hover:text-red-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <TrashIcon className="h-3.5 w-3.5" />
        Delete
      </button>
      <ConfirmDialog
        ref={dialogRef}
        title={confirmTitle}
        description={confirmDescription}
        confirmLabel="Delete"
        destructive
        onConfirm={handleConfirm}
      />
    </>
  );
}
