"use client";

import { useRef, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/toast/toast-provider";
import { changeInvoiceStatusAction } from "@/app/(dashboard)/invoices/[id]/status-actions";
import { ALLOWED_STATUS_TRANSITIONS } from "@/lib/invoices/lifecycle";
import type { InvoiceStatusValue } from "@/lib/validation/invoice";

/** Human copy per (from, to) pair — "Issued" terminology throughout, never "Sent" (docs/invoicing-architecture.md §3.1). */
const TRANSITION_LABELS: Partial<Record<string, string>> = {
  "SENT:PAID": "Mark as paid",
  "SENT:OVERDUE": "Mark as overdue",
  "OVERDUE:PAID": "Mark as paid",
  "OVERDUE:SENT": "Mark as issued",
  "PAID:SENT": "Undo — mark as issued",
};

/**
 * Invoice System Slice 2b/2c — lifecycle transition buttons for an
 * existing non-DRAFT invoice, plus Cancel (the same CANCELLED transition,
 * behind a confirmation dialog, never a separate business implementation
 * — §3.2), plus a Duplicate-as-new-DRAFT navigation link for a terminal
 * CANCELLED invoice (the remaining piece of official Slice 2, completing
 * §3.2's "Cancel + Duplicate-as-new-DRAFT" correction flow). No status
 * dropdown anywhere. Reuses changeInvoiceStatusAction for every status
 * button, including Cancel — Duplicate is deliberately a plain `<Link>`,
 * never a Server Action, since opening it performs zero mutation.
 */
export function InvoiceLifecycleControls({
  invoiceId,
  status,
  invoiceNumber,
}: {
  invoiceId: string;
  status: InvoiceStatusValue;
  invoiceNumber: string;
}) {
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const cancelDialogRef = useRef<ConfirmDialogHandle>(null);

  const allTargets = ALLOWED_STATUS_TRANSITIONS[status];
  const targets = allTargets.filter((target) => target !== "CANCELLED");
  const canCancel = allTargets.includes("CANCELLED");
  // CANCELLED is terminal (no entries in ALLOWED_STATUS_TRANSITIONS), but
  // it is the one status Duplicate is available for — the early return
  // below must not collapse this component to nothing for it.
  const canDuplicate = status === "CANCELLED";

  if (targets.length === 0 && !canCancel && !canDuplicate) return null;

  function runTransition(target: string) {
    startTransition(async () => {
      const result = await changeInvoiceStatusAction(invoiceId, target);
      if (result.ok) {
        showToast("Invoice updated");
      } else {
        showToast("This invoice could not be updated — it may have changed elsewhere. Refresh and try again.", "error");
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {targets.map((target) => (
        <Button
          key={target}
          type="button"
          disabled={pending}
          loading={pending}
          onClick={() => runTransition(target)}
          variant="secondary"
        >
          {TRANSITION_LABELS[`${status}:${target}`] ?? target}
        </Button>
      ))}
      {canCancel && (
        <>
          <Button
            type="button"
            disabled={pending}
            onClick={() => cancelDialogRef.current?.open()}
            variant="dangerOutline"
          >
            Cancel invoice
          </Button>
          <ConfirmDialog
            ref={cancelDialogRef}
            title="Cancel invoice"
            description={`Cancel invoice ${invoiceNumber}? This cannot be undone.`}
            confirmLabel="Cancel invoice"
            destructive
            onConfirm={() => runTransition("CANCELLED")}
          />
        </>
      )}
      {canDuplicate && (
        <Link
          href={`/invoices/${invoiceId}/duplicate`}
          className="inline-flex items-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-900 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
        >
          Duplicate as new draft
        </Link>
      )}
    </div>
  );
}
