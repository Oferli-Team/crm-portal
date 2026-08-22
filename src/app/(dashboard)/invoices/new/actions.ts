"use server";

import { redirect } from "next/navigation";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { parseInvoiceForm, mapInvoiceCalculationError } from "@/lib/validation/invoice";
import { withToast } from "@/lib/toast-url";
import { createActivity } from "@/lib/activity/create-activity";
import { buildInvoiceSnapshotMetadata } from "@/lib/activity/invoice-metadata";
import { calculateInvoiceTotals } from "@/lib/invoices/calculations";
import { mapInvoiceWriteError } from "@/lib/invoices/write-conflict-mapper";
import type { InvoiceFormState } from "@/types";

export async function createInvoiceAction(
  _prevState: InvoiceFormState,
  formData: FormData,
): Promise<InvoiceFormState> {
  const parsed = parseInvoiceForm(formData);
  if (!parsed.ok) {
    return { error: null, fieldErrors: parsed.fieldErrors, lineItemErrors: parsed.lineItemErrors };
  }
  const { values } = parsed;

  const { user, organizationId } = await getCurrentUserOrganization();

  // The <select> only lists this org's projects, but the submitted value
  // is still client-controlled input — re-verify ownership server-side so a
  // tampered projectId can never attach an invoice to another org's project.
  // Also require the project's client to be in the same org, so a stale or
  // inconsistent clientId FK can never carry over onto the invoice.
  const project = await prisma.project.findFirst({
    where: { id: values.projectId, organizationId, client: { organizationId } },
    select: { id: true, clientId: true, name: true },
  });

  if (!project) {
    return { error: null, fieldErrors: { projectId: "Select a valid project." } };
  }

  const calc = calculateInvoiceTotals({
    subtotalSource:
      values.mode === "flat"
        ? { mode: "flat", amount: values.amount ?? "" }
        : { mode: "lineItems", lineItems: values.lineItems ?? [] },
    discount:
      values.discountType === "NONE"
        ? { type: "NONE" }
        : { type: values.discountType, value: values.discountValue ?? "" },
    taxRatePercent: values.taxRatePercent,
  });

  if (!calc.ok) {
    const mapped = mapInvoiceCalculationError(calc.error, values.mode);
    return { error: null, fieldErrors: mapped.fieldErrors, lineItemErrors: mapped.lineItemErrors };
  }

  try {
    // Invoice create and its Activity row are one atomic unit — if the
    // Activity insert fails for any reason, the Invoice create rolls back
    // with it rather than leaving an unlogged row behind.
    await prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.create({
        data: {
          invoiceNumber: values.invoiceNumber,
          // Forced — never from formData. Direct creation in any other
          // status is forbidden (docs/invoicing-architecture.md §3.1).
          status: "DRAFT",
          paidAt: null,
          // The server always recomputes every total and discards any
          // client-submitted total — calc.total/subtotal/discountAmount/
          // taxAmount are the only values ever written here.
          amount: calc.total,
          subtotal: calc.subtotal,
          discountAmount: calc.discountAmount,
          taxAmount: calc.taxAmount,
          discountType: values.discountType,
          discountValue: values.discountType === "NONE" ? null : values.discountValue,
          taxRatePercent: values.taxRatePercent,
          taxLabel: values.taxLabel,
          currency: values.currency,
          issueDate: values.issueDate,
          dueDate: values.dueDate,
          notes: values.notes,
          internalNotes: values.internalNotes,
          projectId: project.id,
          // Derived from the project, never a form field — keeps the two
          // FKs from ever disagreeing about which client this invoice bills.
          clientId: project.clientId,
          // Also derived from the verified project (the findFirst above
          // already matched project.organizationId === organizationId), not
          // from formData.
          organizationId,
          lineItems:
            values.mode === "itemized"
              ? {
                  create: calc.lineItems.map((lineItem, index) => ({
                    description: lineItem.description,
                    quantity: lineItem.quantity,
                    unitPrice: lineItem.unitPrice,
                    lineTotal: lineItem.lineTotal,
                    position: index,
                  })),
                }
              : undefined,
        },
      });

      // INVOICE/CREATED has no entry in notification-rules.ts's RULES
      // table — only STATUS_CHANGED ever fans out to a Notification. No
      // notification rule is invented here.
      await createActivity(tx, {
        organizationId,
        actorId: user.id,
        entityType: "INVOICE",
        entityId: invoice.id,
        action: "CREATED",
        metadata: buildInvoiceSnapshotMetadata(invoice, calc.lineItems.length, project.name, user.name),
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      if (mapInvoiceWriteError(err) === "INVOICE_NUMBER_CONFLICT") {
        return {
          error: null,
          fieldErrors: {
            invoiceNumber: "An invoice with this number already exists.",
          },
        };
      }
      return { error: "This invoice could not be saved due to a conflicting change. Please try again." };
    }
    throw err;
  }

  redirect(withToast("/invoices", "Invoice created"));
}
