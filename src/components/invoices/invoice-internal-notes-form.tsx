"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/toast/toast-provider";
import { updateInvoiceInternalNotesAction } from "@/app/(dashboard)/invoices/[id]/internal-notes-actions";

/**
 * Invoice System Slice 2b — the dedicated inline internalNotes editor for
 * a non-DRAFT invoice (DRAFT uses the main edit form's own internalNotes
 * field instead, §3.3). Editable in every status, never rendered to the
 * client/PDF/email.
 */
export function InvoiceInternalNotesForm({ invoiceId, initialValue }: { invoiceId: string; initialValue: string }) {
  const [value, setValue] = useState(initialValue);
  const [pending, startTransition] = useTransition();
  const { showToast } = useToast();

  function handleSave() {
    startTransition(async () => {
      const result = await updateInvoiceInternalNotesAction(invoiceId, value);
      if (result.ok) {
        showToast("Internal notes saved");
      } else if (result.error === "TOO_LONG") {
        showToast("Internal notes are too long (max 10,000 characters).", "error");
      } else {
        showToast("This invoice could not be found.", "error");
      }
    });
  }

  return (
    <div>
      <label htmlFor="invoice-internal-notes" className="block text-sm font-medium text-gray-700">
        Internal notes
      </label>
      <Textarea id="invoice-internal-notes" rows={3} value={value} onChange={(event) => setValue(event.target.value)} />
      <p className="mt-1 text-xs text-gray-500">Staff-only — never shown to the client.</p>
      <div className="mt-2">
        <Button type="button" onClick={handleSave} loading={pending} disabled={pending}>
          Save notes
        </Button>
      </div>
    </div>
  );
}
