import { notFound } from "next/navigation";
import Link from "next/link";
import { getCurrentMembership } from "@/lib/current-user";
import { prisma } from "@/lib/prisma";
import { InvoiceDraftPanel } from "@/components/invoices/invoice-draft-panel";
import { InvoiceReadOnlyView } from "@/components/invoices/invoice-read-only-view";
import { buildInvoiceTotalsViewModel } from "@/lib/invoices/totals-view-model";
import { getSupportedInvoiceCurrencies } from "@/lib/invoices/currencies";
import { formatDateOnly } from "@/lib/invoices/date-only";
import { canAccessPaymentDetails } from "@/lib/organization-setup/authorization";
import { classifyInvoiceArchival } from "@/lib/invoices/pdf/classify-archival";
import { updateInvoiceAction } from "./actions";
import { InvoiceAttachmentsSection } from "./attachments-section";
import { loadInvoiceEmailAttempts } from "@/lib/invoices/email/attempt-history";

export default async function EditInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { user, organizationId, membership } = await getCurrentMembership();
  // Invoice System Official Slice 3, sub-PR 3b — Issue is OWNER-only,
  // reusing the exact same authorization boundary payment details already
  // established (src/lib/organization-setup/authorization.ts). This only
  // gates whether the control is rendered at all — issueInvoiceAction()
  // and issueInvoice() both independently re-check this server-side, so
  // hiding the control here is a UX convenience, never the enforcement.
  const canIssue = canAccessPaymentDetails(membership.role);

  // The one shared Invoice fetch, needed by both branches — ordered line
  // items and Project/Client display, never a duplicate Invoice lookup.
  // No `attachments` — Invoice has no such relation; attachments are
  // fetched separately by the existing, unchanged InvoiceAttachmentsSection.
  const invoice = await prisma.invoice.findFirst({
    where: { id, organizationId, project: { organizationId } },
    include: {
      lineItems: { orderBy: { position: "asc" } },
      project: { select: { name: true, client: { select: { name: true } } } },
    },
  });

  if (!invoice) {
    notFound();
  }

  const isDraft = invoice.status === "DRAFT";
  // Invoice System Official Slice 3 — the one place this page ever
  // touches archival state. `include` above already retains every
  // Invoice scalar column (finalizedAt/pdfStoragePath/pdfGeneratedAt/
  // issuerSnapshot/recipientSnapshot/documentVersion), so no query change
  // is needed. classifyInvoiceArchival() is called exactly once, here,
  // its result bound to `archivalClassification`, and only the two
  // derived booleans below ever cross into InvoiceReadOnlyView's props —
  // never pdfStoragePath, a ledger id, a snapshot, or a signed URL. The
  // two booleans are structurally mutually exclusive (a row can never be
  // both `archived` and `legacy_eligible`). `canArchiveLegacy` also
  // requires OWNER UI-capability (`canIssue`, reused verbatim) — this is
  // visibility only, never enforcement; archiveLegacyInvoiceAction() and
  // archiveLegacyInvoice() both independently re-check OWNER access.
  const archivalClassification = classifyInvoiceArchival(invoice);
  const hasArchivedPdf = archivalClassification.kind === "archived";
  const canArchiveLegacy = archivalClassification.kind === "legacy_eligible" && canIssue;
  const canSendEmail = hasArchivedPdf && canIssue;
  const actor = { organizationId, userId: user.id, userName: user.name, role: membership.role };
  const emailAttempts = canSendEmail ? await loadInvoiceEmailAttempts(actor, invoice.id) : [];

  // The full project option list is fetched only for the DRAFT branch —
  // the read-only view never offers a project-changing control.
  const projects = isDraft
    ? await prisma.project.findMany({
        where: { organizationId },
        orderBy: { name: "asc" },
        select: { id: true, name: true, client: { select: { name: true } } },
      })
    : null;

  const boundUpdateInvoiceAction = updateInvoiceAction.bind(null, invoice.id, invoice.updatedAt.toISOString());

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
          {isDraft ? "Edit invoice" : "Invoice"}
        </h1>
        <Link
          href="/invoices"
          className="rounded text-sm text-gray-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
        >
          Back
        </Link>
      </div>
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        {isDraft ? (
          <InvoiceDraftPanel
            invoiceId={invoice.id}
            invoiceNumber={invoice.invoiceNumber}
            expectedUpdatedAt={invoice.updatedAt.toISOString()}
            canIssue={canIssue}
            action={boundUpdateInvoiceAction}
            projects={(projects ?? []).map((project) => ({
              id: project.id,
              label: `${project.name} — ${project.client.name}`,
            }))}
            currencyOptions={getSupportedInvoiceCurrencies()}
            defaultValues={{
              invoiceNumber: invoice.invoiceNumber,
              projectId: invoice.projectId,
              mode: invoice.lineItems.length > 0 ? "itemized" : "flat",
              amount: invoice.amount.toString(),
              lineItems: invoice.lineItems.map((li) => ({
                description: li.description,
                quantity: li.quantity.toString(),
                unitPrice: li.unitPrice.toString(),
              })),
              // The invoice row's own persisted currency — never silently
              // replaced by the current organization default.
              currency: invoice.currency,
              issueDate: formatDateOnly(invoice.issueDate),
              dueDate: invoice.dueDate ? formatDateOnly(invoice.dueDate) : "",
              notes: invoice.notes ?? "",
              internalNotes: invoice.internalNotes ?? "",
              discountType: invoice.discountType,
              discountValue: invoice.discountValue?.toString() ?? "",
              taxRatePercent: invoice.taxRatePercent?.toString() ?? "",
              taxLabel: invoice.taxLabel,
            }}
          />
        ) : (
          <InvoiceReadOnlyView
            invoiceId={invoice.id}
            invoiceNumber={invoice.invoiceNumber}
            status={invoice.status}
            projectName={invoice.project.name}
            clientName={invoice.project.client.name}
            currency={invoice.currency}
            issueDate={invoice.issueDate}
            dueDate={invoice.dueDate}
            paidAt={invoice.paidAt}
            lineItems={invoice.lineItems.map((li) => ({
              description: li.description,
              quantity: li.quantity,
              unitPrice: li.unitPrice,
              lineTotal: li.lineTotal,
            }))}
            notes={invoice.notes}
            internalNotes={invoice.internalNotes}
            hasArchivedPdf={hasArchivedPdf}
            canArchiveLegacy={canArchiveLegacy}
            canSendEmail={canSendEmail}
            emailAttempts={emailAttempts}
            expectedUpdatedAt={invoice.updatedAt.toISOString()}
            totals={buildInvoiceTotalsViewModel({
              amount: invoice.amount,
              subtotal: invoice.subtotal,
              discountType: invoice.discountType,
              discountAmount: invoice.discountAmount,
              discountValue: invoice.discountValue,
              taxRatePercent: invoice.taxRatePercent,
              taxAmount: invoice.taxAmount,
              taxLabel: invoice.taxLabel,
              currency: invoice.currency,
            })}
          />
        )}
        <InvoiceAttachmentsSection invoiceId={invoice.id} organizationId={organizationId} />
      </div>
    </div>
  );
}
