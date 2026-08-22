"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/toast/toast-provider";
import { sendInvoiceEmailAction } from "@/app/(dashboard)/invoices/[id]/edit/send-email-actions";
import type { InvoiceEmailAttemptSummary } from "@/lib/invoices/email/attempt-history";

function statusLabel(status: InvoiceEmailAttemptSummary["status"]): string {
  if (status === "ACCEPTED") return "Accepted by provider";
  if (status === "FAILED") return "Failed";
  if (status === "UNKNOWN") return "Status unknown";
  return "Sending";
}

export function InvoiceSendControls({
  invoiceId,
  invoiceNumber,
  expectedUpdatedAt,
  disabled = false,
  attempts = [],
}: {
  invoiceId: string;
  invoiceNumber: string;
  expectedUpdatedAt?: string;
  disabled?: boolean;
  attempts?: InvoiceEmailAttemptSummary[];
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const dialogRef = useRef<ConfirmDialogHandle>(null);
  const isIssueAndSend = expectedUpdatedAt !== undefined;
  const latest = attempts[0];
  const acknowledgeUnknownId = latest?.status === "UNKNOWN" ? latest.id : undefined;

  function runSend() {
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof sendInvoiceEmailAction>>;
      try {
        result = await sendInvoiceEmailAction(invoiceId, idempotencyKey, expectedUpdatedAt, acknowledgeUnknownId);
      } catch {
        showToast("Could not send this invoice — try again.", "error");
        return;
      }

      if (result.ok) {
        setIdempotencyKey(crypto.randomUUID());
        if (result.outcome === "ACCEPTED") {
          showToast(result.invoiceFinalizedAt ? "Invoice issued and accepted for sending" : "Invoice accepted for sending");
        } else if (result.outcome === "FAILED") {
          showToast(result.invoiceFinalizedAt ? "Invoice issued, but the email could not be sent." : "The email could not be sent — you can retry.", "error");
        } else if (result.outcome === "UNKNOWN") {
          showToast(result.invoiceFinalizedAt ? "Invoice issued. Email status is unknown — check before retrying." : "Email status is unknown — retrying may send a duplicate.", "error");
        } else {
          showToast("Invoice issued, but the email could not be sent. Retry from this invoice page.", "error");
        }
        router.refresh();
        return;
      }

      if (result.error === "NOT_FOUND" || result.error === "STALE_VERSION") {
        showToast("This invoice changed elsewhere — refreshing…", "error");
        router.refresh();
      } else if (result.error === "FORBIDDEN") {
        showToast("Only the organization owner can send invoices.", "error");
      } else if (result.error === "RATE_LIMITED") {
        showToast("Too many requests. Please try again later.", "error");
      } else if (result.error === "EMAIL_NOT_CONFIGURED") {
        showToast("Invoice email is not configured — contact support.", "error");
      } else if (result.error === "NO_RECIPIENT_EMAIL" || result.error === "INVALID_RECIPIENT_EMAIL") {
        showToast("Add a valid email address to this client before sending.", "error");
      } else if (result.error === "ALREADY_PENDING") {
        showToast("An email attempt is already in progress.", "error");
        router.refresh();
      } else if (result.error === "UNKNOWN_ACKNOWLEDGEMENT_REQUIRED" || result.error === "INVALID_UNKNOWN_ACKNOWLEDGEMENT") {
        showToast("The previous email's status is unknown. Refresh and confirm the resend warning.", "error");
        router.refresh();
      } else if (result.error === "ARCHIVE_NOT_AVAILABLE") {
        showToast("The archived invoice PDF is unavailable — contact support.", "error");
      } else {
        showToast("Could not send this invoice — try again.", "error");
      }
    });
  }

  const buttonLabel = isIssueAndSend ? "Issue & Send" : latest?.status === "ACCEPTED" ? "Resend invoice" : "Send invoice";
  const unknownWarning = acknowledgeUnknownId
    ? "The previous email's status is unknown. It may already have been accepted, so resending can create a duplicate."
    : null;

  return (
    <div className="space-y-3">
      {disabled && <p className="text-sm text-amber-700">Save changes before issuing and sending.</p>}
      <Button
        type="button"
        disabled={disabled || pending || latest?.status === "PENDING"}
        loading={pending}
        onClick={() => dialogRef.current?.open()}
        variant="secondary"
      >
        {buttonLabel}
      </Button>
      <ConfirmDialog
        ref={dialogRef}
        title={buttonLabel}
        description={unknownWarning ?? `${buttonLabel} ${invoiceNumber}? The immutable archived PDF will be attached to the email.`}
        confirmLabel={acknowledgeUnknownId ? "Resend anyway" : buttonLabel}
        destructive={Boolean(acknowledgeUnknownId) || isIssueAndSend}
        onConfirm={runSend}
      />

      {attempts.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-700">Email attempts</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {attempts.map((attempt) => (
              <li key={attempt.id} className="rounded border border-gray-200 px-3 py-2 text-gray-700">
                <span className="font-medium text-gray-900">{statusLabel(attempt.status)}</span>
                <span className="mx-2 text-gray-400">·</span>
                <span>{attempt.recipientEmail}</span>
                <span className="mx-2 text-gray-400">·</span>
                <time dateTime={attempt.attemptedAt.toISOString()}>{attempt.attemptedAt.toLocaleString()}</time>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
