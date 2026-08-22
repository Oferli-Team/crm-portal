"use client";

import { useState } from "react";
import { InvoiceForm } from "./invoice-form";
import { InvoiceIssueControls } from "./invoice-issue-controls";
import { InvoiceSendControls } from "./invoice-send-controls";
import type { InvoiceFormState } from "@/types";
import type { InvoiceLineItemFormValue } from "@/lib/invoices/line-items-form";

type InvoiceFormDefaults = {
  invoiceNumber?: string;
  projectId?: string;
  mode?: "flat" | "itemized";
  amount?: string;
  lineItems?: InvoiceLineItemFormValue[];
  currency?: string;
  issueDate?: string;
  dueDate?: string;
  notes?: string;
  internalNotes?: string;
  discountType?: "NONE" | "PERCENTAGE" | "FIXED";
  discountValue?: string;
  taxRatePercent?: string;
  taxLabel?: "TAX" | "VAT" | "GST";
};

/**
 * Invoice System Official Slice 3, sub-PR 3b — the small client-side
 * coordinator between the DRAFT edit form and the Issue control. Owns the
 * one bit of state neither InvoiceForm nor InvoiceIssueControls can own by
 * itself: whether the currently-displayed form still matches what's
 * persisted. Starts clean on every fresh mount (a full page load/
 * navigation, e.g. after a save's own redirect back into the list and
 * back into this invoice) and only ever becomes dirty from here on — it
 * never needs to reset to false within one mount, since
 * updateInvoiceAction's own successful-save path always redirects away
 * from this page entirely (see its own header comment), so "saved, still
 * on this page, now clean again" is not a reachable state to model.
 */
export function InvoiceDraftPanel({
  invoiceId,
  invoiceNumber,
  expectedUpdatedAt,
  canIssue,
  action,
  projects,
  currencyOptions,
  currencyFallbackNotice,
  defaultValues,
}: {
  invoiceId: string;
  invoiceNumber: string;
  expectedUpdatedAt: string;
  canIssue: boolean;
  action: (prevState: InvoiceFormState, formData: FormData) => Promise<InvoiceFormState>;
  projects: { id: string; label: string }[];
  currencyOptions: readonly string[];
  currencyFallbackNotice?: string;
  defaultValues?: InvoiceFormDefaults;
}) {
  const [dirty, setDirty] = useState(false);

  return (
    <>
      <InvoiceForm
        action={action}
        projects={projects}
        currencyOptions={currencyOptions}
        currencyFallbackNotice={currencyFallbackNotice}
        defaultValues={defaultValues}
        submitLabel="Save changes"
        pendingLabel="Saving…"
        onDirtyChange={() => setDirty(true)}
      />
      {canIssue && (
        <div className="mt-6 border-t border-gray-200 pt-6">
          <InvoiceIssueControls
            invoiceId={invoiceId}
            invoiceNumber={invoiceNumber}
            expectedUpdatedAt={expectedUpdatedAt}
            disabled={dirty}
          />
          <InvoiceSendControls
            invoiceId={invoiceId}
            invoiceNumber={invoiceNumber}
            expectedUpdatedAt={expectedUpdatedAt}
            disabled={dirty}
          />
        </div>
      )}
    </>
  );
}
