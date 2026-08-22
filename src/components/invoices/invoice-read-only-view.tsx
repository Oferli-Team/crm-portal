import type { Prisma } from "@/generated/prisma/client";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatInvoiceStatusLabel } from "@/lib/invoices/status-label";
import { formatInvoiceCurrencyAmount } from "@/lib/invoices/currencies";
import { formatDateOnlyForDisplay } from "@/lib/invoices/date-only";
import { InvoiceLifecycleControls } from "./invoice-lifecycle-controls";
import { InvoiceInternalNotesForm } from "./invoice-internal-notes-form";
import { InvoiceLegacyArchiveControls } from "./invoice-legacy-archive-controls";
import { InvoiceSendControls } from "./invoice-send-controls";
import type { InvoiceEmailAttemptSummary } from "@/lib/invoices/email/attempt-history";
import type { InvoiceStatusValue } from "@/lib/validation/invoice";
import type { InvoiceTotalsViewModel } from "@/lib/invoices/totals-view-model";

type MoneyValue = Prisma.Decimal | string | number;

export type InvoiceReadOnlyLineItem = { description: string; quantity: MoneyValue; unitPrice: MoneyValue; lineTotal: MoneyValue };

/**
 * The complete visible contract for an existing non-DRAFT invoice
 * (docs/invoicing-architecture.md §4.6). Never fabricates a line item for
 * a flat invoice, and renders no editable frozen field, Issue, Send, or
 * email control. Duplicate (via InvoiceLifecycleControls, §3.2) is
 * available only for a terminal CANCELLED invoice, never for
 * SENT/PAID/OVERDUE. As of Invoice System Official Slice 3, sub-PR 3c, a
 * genuinely archived invoice (`hasArchivedPdf`, computed server-side by
 * the caller via classifyInvoiceArchival() — never derived here, and
 * never backed by pdfStoragePath/a ledger id/a snapshot/a signed URL
 * crossing into this component's own props) renders one plain
 * "Download PDF" link. As of Invoice System Official Slice 3, Legacy
 * Archive, a `legacy_eligible` invoice (also computed server-side by the
 * caller, never derived here) instead renders the OWNER-only "Archive
 * Legacy Invoice" control — the two are always mutually exclusive, since
 * a row can never be both `archived` and `legacy_eligible` at once. DRAFT
 * never reaches this component at all; every `invariant_violation` reason
 * renders neither control.
 */
export function InvoiceReadOnlyView({
  invoiceId,
  invoiceNumber,
  status,
  projectName,
  clientName,
  currency,
  issueDate,
  dueDate,
  paidAt,
  lineItems,
  notes,
  internalNotes,
  hasArchivedPdf,
  canArchiveLegacy,
  canSendEmail,
  emailAttempts,
  expectedUpdatedAt,
  totals,
}: {
  invoiceId: string;
  invoiceNumber: string;
  status: InvoiceStatusValue;
  projectName: string;
  clientName: string;
  currency: string;
  issueDate: Date;
  dueDate: Date | null;
  paidAt: Date | null;
  lineItems: InvoiceReadOnlyLineItem[];
  notes: string | null;
  internalNotes: string | null;
  hasArchivedPdf: boolean;
  canArchiveLegacy: boolean;
  canSendEmail: boolean;
  emailAttempts: InvoiceEmailAttemptSummary[];
  expectedUpdatedAt: string;
  totals: InvoiceTotalsViewModel;
}) {
  const format = (value: MoneyValue) => formatInvoiceCurrencyAmount(value, currency) ?? String(value);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{invoiceNumber}</h2>
          <p className="mt-1 text-sm text-gray-600">
            {projectName} — {clientName}
          </p>
        </div>
        <StatusBadge status={status} label={formatInvoiceStatusLabel(status)} />
      </div>

      <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-gray-500">Currency</dt>
          <dd className="mt-0.5 text-gray-900">{currency}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Issue date</dt>
          <dd className="mt-0.5 text-gray-900">{formatDateOnlyForDisplay(issueDate)}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Due date</dt>
          <dd className="mt-0.5 text-gray-900">{dueDate ? formatDateOnlyForDisplay(dueDate) : "—"}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Paid date</dt>
          <dd className="mt-0.5 text-gray-900">{paidAt ? paidAt.toLocaleDateString() : "—"}</dd>
        </div>
      </dl>

      {lineItems.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-gray-200">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-gray-600">Description</th>
                <th className="px-3 py-2 text-right font-medium text-gray-600">Qty</th>
                <th className="px-3 py-2 text-right font-medium text-gray-600">Unit price</th>
                <th className="px-3 py-2 text-right font-medium text-gray-600">Line total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {lineItems.map((item, index) => (
                <tr key={index}>
                  <td className="px-3 py-2 text-gray-900">{item.description}</td>
                  <td className="px-3 py-2 text-right text-gray-700">{String(item.quantity)}</td>
                  <td className="px-3 py-2 text-right text-gray-700">{format(item.unitPrice)}</td>
                  <td className="px-3 py-2 text-right text-gray-900">{format(item.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="ml-auto max-w-xs space-y-1 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-500">Subtotal</span>
          <span className="text-gray-900">{totals.displayedSubtotal}</span>
        </div>
        {totals.discountRow && (
          <div className="flex justify-between">
            <span className="text-gray-500">{totals.discountRow.label}</span>
            <span className="text-gray-900">-{totals.discountRow.amount}</span>
          </div>
        )}
        {totals.taxRow && (
          <div className="flex justify-between">
            <span className="text-gray-500">{totals.taxRow.label}</span>
            <span className="text-gray-900">{totals.taxRow.amount}</span>
          </div>
        )}
        <div className="flex justify-between border-t border-gray-200 pt-1 font-medium">
          <span className="text-gray-900">Total</span>
          <span className="text-gray-900">{totals.total}</span>
        </div>
      </div>

      {notes && (
        <div>
          <h3 className="text-sm font-medium text-gray-700">Notes</h3>
          <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700">{notes}</p>
        </div>
      )}

      <InvoiceInternalNotesForm invoiceId={invoiceId} initialValue={internalNotes ?? ""} />

      {hasArchivedPdf && (
        <a
          href={`/api/invoices/${invoiceId}/pdf`}
          className="inline-block rounded text-sm font-medium text-gray-700 transition-colors hover:text-gray-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
        >
          Download PDF
        </a>
      )}

      {canArchiveLegacy && (
        <InvoiceLegacyArchiveControls invoiceId={invoiceId} invoiceNumber={invoiceNumber} expectedUpdatedAt={expectedUpdatedAt} />
      )}

      {canSendEmail && (
        <InvoiceSendControls invoiceId={invoiceId} invoiceNumber={invoiceNumber} attempts={emailAttempts} />
      )}

      <InvoiceLifecycleControls invoiceId={invoiceId} status={status} invoiceNumber={invoiceNumber} />
    </div>
  );
}
