"use client";

import { useRef, useState } from "react";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/toast/toast-provider";

export function CancelInvitationButton({
  action,
  email,
}: {
  /** A bound, zero-argument server action (e.g. cancelInvitationAction.bind(null, id)). */
  action: () => Promise<void>;
  email: string;
}) {
  const dialogRef = useRef<ConfirmDialogHandle>(null);
  const { showToast } = useToast();
  const [pending, setPending] = useState(false);

  async function handleConfirm() {
    setPending(true);
    try {
      await action();
      showToast("Invitation canceled");
    } catch {
      showToast(`Failed to cancel the invitation for ${email}.`, "error");
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
        className="rounded text-sm font-medium text-red-600 transition-colors hover:text-red-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        Cancel
      </button>
      <ConfirmDialog
        ref={dialogRef}
        title="Cancel invitation"
        description={`Cancel the invitation for ${email}? They won't be able to use this link to join.`}
        confirmLabel="Cancel invitation"
        destructive
        onConfirm={handleConfirm}
      />
    </>
  );
}
