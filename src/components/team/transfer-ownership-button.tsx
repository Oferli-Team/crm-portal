"use client";

import { useRef, useState } from "react";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/toast/toast-provider";

export function TransferOwnershipButton({
  memberName,
  onConfirm,
}: {
  memberName: string;
  /** Calls changeRoleAction(membershipId, "OWNER") and returns its error, if any. */
  onConfirm: () => Promise<{ error: string | null }>;
}) {
  const dialogRef = useRef<ConfirmDialogHandle>(null);
  const { showToast } = useToast();
  const [pending, setPending] = useState(false);

  async function handleConfirm() {
    setPending(true);
    try {
      const result = await onConfirm();
      if (result.error) {
        showToast(result.error, "error");
      } else {
        showToast(`${memberName} is now the owner`);
      }
    } catch {
      showToast(`Failed to transfer ownership to ${memberName}.`, "error");
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
        className="rounded text-sm font-medium text-gray-700 transition-colors hover:text-gray-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        Make owner
      </button>
      <ConfirmDialog
        ref={dialogRef}
        title="Transfer ownership"
        description={`Make ${memberName} the owner of this organization? You will become an Admin.`}
        confirmLabel="Transfer ownership"
        destructive
        onConfirm={handleConfirm}
      />
    </>
  );
}
