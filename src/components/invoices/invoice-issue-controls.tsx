"use client";

import { useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/toast/toast-provider";
import { issueInvoiceAction } from "@/app/(dashboard)/invoices/[id]/edit/issue-actions";

/**
 * Invoice System Official Slice 3, sub-PR 3b — OWNER-only Issue control for
 * a DRAFT invoice, rendered by InvoiceDraftPanel alongside InvoiceForm.
 * `expectedUpdatedAt` is always the page's own render-time
 * `invoice.updatedAt.toISOString()` — never re-fetched client-side. On a
 * stale/conflict/not-draft result this refreshes the page (never retries
 * with the same stale value); no PDF download link exists here — the
 * staff signed-download route is sub-PR 3c's.
 */
export function InvoiceIssueControls({
  invoiceId,
  invoiceNumber,
  expectedUpdatedAt,
  disabled,
}: {
  invoiceId: string;
  invoiceNumber: string;
  expectedUpdatedAt: string;
  disabled: boolean;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const dialogRef = useRef<ConfirmDialogHandle>(null);

  function runIssue() {
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof issueInvoiceAction>>;
      try {
        result = await issueInvoiceAction(invoiceId, expectedUpdatedAt);
      } catch {
        // A rejected Server Action call (e.g. a network/transport error
        // reaching the server at all) is indistinguishable from any other
        // safe failure here — same generic message, no thrown detail ever
        // surfaced, no automatic retry. useTransition's own pending state
        // still resolves to false once this async callback returns, so
        // the button is never left stuck in a permanently pending state.
        showToast("Could not issue this invoice — try again.", "error");
        return;
      }

      if (result.ok) {
        showToast("Invoice issued");
        router.refresh();
        return;
      }

      if (result.error === "STALE_VERSION" || result.error === "CONFLICT" || result.error === "NOT_DRAFT" || result.error === "NOT_FOUND") {
        showToast("This invoice changed elsewhere — refreshing…", "error");
        router.refresh();
        return;
      }

      if (result.error === "FORBIDDEN") {
        showToast("Only the organization owner can issue invoices.", "error");
        return;
      }

      showToast("Could not issue this invoice — try again.", "error");
    });
  }

  return (
    <div className="flex flex-col items-start gap-2">
      {disabled && <p className="text-sm text-amber-700">Save changes before issuing.</p>}
      <Button
        type="button"
        disabled={disabled || pending}
        loading={pending}
        onClick={() => dialogRef.current?.open()}
        variant="secondary"
      >
        Issue invoice
      </Button>
      <ConfirmDialog
        ref={dialogRef}
        title="Issue invoice"
        description={`Issue invoice ${invoiceNumber}? This creates a permanent, immutable PDF record and cannot be undone.`}
        confirmLabel="Issue invoice"
        destructive
        onConfirm={runIssue}
      />
    </div>
  );
}
