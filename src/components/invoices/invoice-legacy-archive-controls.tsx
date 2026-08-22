"use client";

import { useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/toast/toast-provider";
import { archiveLegacyInvoiceAction } from "@/app/(dashboard)/invoices/[id]/edit/legacy-archive-actions";

/**
 * Invoice System Official Slice 3, Legacy Archive — OWNER-only archival
 * control for a legacy_eligible non-DRAFT invoice, rendered by
 * InvoiceReadOnlyView alongside (mutually exclusive with) the existing
 * "Download PDF" link. Mirrors InvoiceIssueControls exactly.
 * `expectedUpdatedAt` is always the page's own render-time
 * `invoice.updatedAt.toISOString()` — never re-fetched client-side. On a
 * stale/conflict/no-longer-eligible result this refreshes the page (never
 * retries with the same stale value). This Client Component imports only
 * the Server Action and plain types — never any server-only PDF module.
 */
export function InvoiceLegacyArchiveControls({
  invoiceId,
  invoiceNumber,
  expectedUpdatedAt,
}: {
  invoiceId: string;
  invoiceNumber: string;
  expectedUpdatedAt: string;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const dialogRef = useRef<ConfirmDialogHandle>(null);

  function runArchive() {
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof archiveLegacyInvoiceAction>>;
      try {
        result = await archiveLegacyInvoiceAction(invoiceId, expectedUpdatedAt);
      } catch {
        // A rejected Server Action call (e.g. a network/transport error
        // reaching the server at all) is indistinguishable from any other
        // safe failure here — same generic message, no thrown detail ever
        // surfaced, no automatic retry.
        showToast("Could not archive this invoice — try again.", "error");
        return;
      }

      if (result.ok) {
        // Both ARCHIVED and ALREADY_ARCHIVED are non-alarming success —
        // a repeat click after a prior success (or a race lost to another
        // tab/user) is never shown as an error. router.refresh() re-reads
        // the invoice's now-"archived" classification either way, which
        // swaps this control out for the ordinary Download PDF link.
        showToast(result.outcome === "ARCHIVED" ? "Invoice archived" : "This invoice was already archived.");
        router.refresh();
        return;
      }

      if (
        result.error === "STALE_VERSION" ||
        result.error === "CONFLICT" ||
        result.error === "NOT_LEGACY_ELIGIBLE" ||
        result.error === "NOT_FOUND"
      ) {
        showToast("This invoice changed elsewhere — refreshing…", "error");
        router.refresh();
        return;
      }

      if (result.error === "FORBIDDEN") {
        showToast("Only the organization owner can archive legacy invoices.", "error");
        return;
      }

      if (result.error === "UNSUPPORTED_CURRENCY") {
        showToast("This invoice's currency is not supported for PDF archival.", "error");
        return;
      }

      if (result.error === "INVALID_FINANCIAL_STATE") {
        showToast("This invoice's recorded totals could not be verified — contact support.", "error");
        return;
      }

      if (result.error === "INVARIANT_VIOLATION") {
        showToast("This invoice is in an unexpected state and cannot be archived — contact support.", "error");
        return;
      }

      showToast("Could not archive this invoice — try again.", "error");
    });
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        type="button"
        disabled={pending}
        loading={pending}
        onClick={() => dialogRef.current?.open()}
        variant="secondary"
      >
        Archive Legacy Invoice
      </Button>
      <ConfirmDialog
        ref={dialogRef}
        title="Archive legacy invoice"
        description={`Archive invoice ${invoiceNumber}? This creates a permanent PDF using your organization's and this client's current details — not necessarily what was on file when this invoice was originally issued. This cannot be undone.`}
        confirmLabel="Archive invoice"
        destructive
        onConfirm={runArchive}
      />
    </div>
  );
}
