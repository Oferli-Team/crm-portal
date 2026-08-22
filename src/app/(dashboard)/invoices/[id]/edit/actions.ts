"use server";

import { redirect } from "next/navigation";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { parseInvoiceForm, mapInvoiceCalculationError } from "@/lib/validation/invoice";
import { withToast } from "@/lib/toast-url";
import { createActivity } from "@/lib/activity/create-activity";
import { diffInvoiceFields, buildInvoiceUpdatedMetadata, type InvoiceTrackedSnapshot } from "@/lib/activity/invoice-metadata";
import { calculateInvoiceTotals } from "@/lib/invoices/calculations";
import { mapInvoiceWriteError } from "@/lib/invoices/write-conflict-mapper";
import type { InvoiceFormState } from "@/types";

function isCanonicalIso(raw: string): boolean {
  const date = new Date(raw);
  return !Number.isNaN(date.getTime()) && date.toISOString() === raw;
}

/**
 * Invoice System Slice 2b — page-version DRAFT edit concurrency.
 * `expectedUpdatedAt` originates from the DRAFT page's own render
 * (invoice.updatedAt.toISOString(), bound as a Server Action argument —
 * never a visible/editable form input), not from a fresh read performed
 * inside this action. This closes the "stale browser tab" race a
 * status-only or fresh-read-based guard cannot: if ANY write committed
 * since this page was rendered, the row's real updatedAt no longer
 * equals expectedUpdatedAt, and the guarded update below matches zero
 * rows regardless of what a fresh read would show right now.
 */
export async function updateInvoiceAction(
  invoiceId: string,
  expectedUpdatedAt: string,
  _prevState: InvoiceFormState,
  formData: FormData,
): Promise<InvoiceFormState> {
  if (!isCanonicalIso(expectedUpdatedAt)) {
    return { error: "This invoice was reloaded — please refresh and try again." };
  }
  const expectedDate = new Date(expectedUpdatedAt);

  const parsed = parseInvoiceForm(formData);
  if (!parsed.ok) {
    return { error: null, fieldErrors: parsed.fieldErrors, lineItemErrors: parsed.lineItemErrors };
  }
  const { values } = parsed;

  const { user, organizationId } = await getCurrentUserOrganization();

  // Changing the project is allowed, but only to one owned by this org —
  // re-verify server-side regardless of what the <select> offered.
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

  let toastMessage = "Invoice updated";
  try {
    const outcome = await prisma.$transaction(async (tx) => {
      // Still required here — for authorization defense in depth, the
      // current-status check, the Activity before-snapshot, and no-op
      // detection — but its own updatedAt is never substituted for the
      // page-provided expected version below.
      const existing = await tx.invoice.findFirst({
        where: { id: invoiceId, organizationId, project: { organizationId } },
        include: { lineItems: { orderBy: { position: "asc" } } },
      });

      if (!existing) {
        return { status: "not_found" as const };
      }
      if (existing.status !== "DRAFT") {
        return { status: "conflict" as const };
      }

      const beforeSnapshot: InvoiceTrackedSnapshot = {
        invoiceNumber: existing.invoiceNumber,
        projectId: existing.projectId,
        amount: existing.amount,
        currency: existing.currency,
        issueDate: existing.issueDate,
        dueDate: existing.dueDate,
        notes: existing.notes,
        internalNotes: existing.internalNotes,
        discountType: existing.discountType,
        discountValue: existing.discountValue,
        taxRatePercent: existing.taxRatePercent,
        taxLabel: existing.taxLabel,
        lineItems: existing.lineItems.map((li) => ({ description: li.description, quantity: li.quantity, unitPrice: li.unitPrice })),
      };
      const afterSnapshot: InvoiceTrackedSnapshot = {
        invoiceNumber: values.invoiceNumber,
        projectId: project.id,
        amount: calc.total,
        currency: values.currency,
        issueDate: values.issueDate,
        dueDate: values.dueDate,
        notes: values.notes,
        internalNotes: values.internalNotes,
        discountType: values.discountType,
        discountValue: values.discountType === "NONE" ? null : values.discountValue,
        taxRatePercent: values.taxRatePercent,
        taxLabel: values.taxLabel,
        lineItems: calc.lineItems.map((li) => ({ description: li.description, quantity: li.quantity, unitPrice: li.unitPrice })),
      };

      const changedFields = diffInvoiceFields(beforeSnapshot, afterSnapshot);
      if (changedFields.length === 0) {
        // True no-op: no parent UPDATE (updatedAt never bumped), no
        // line-item replacement, no Activity.
        return { status: "noop" as const };
      }

      // The guard's WHERE updatedAt is the PAGE-PROVIDED expected version —
      // never existing.updatedAt. The DATA updatedAt is an explicitly
      // computed, strictly-monotonic replacement for Prisma's implicit
      // @updatedAt behavior: a JS/Prisma timestamp is millisecond-granular,
      // so "a successful UPDATE always produces a value different from
      // expectedDate" is not a safe assumption on its own (two edits
      // completing within the same millisecond, or a clock that hasn't
      // advanced, could otherwise leave updatedAt unchanged or even appear
      // to move backwards relative to a caller's expectation). Taking the
      // max of the real current time and expectedDate + 1ms guarantees the
      // new value is always strictly greater than the page version this
      // edit was guarded against, regardless of wall-clock behavior.
      const nextUpdatedAt = new Date(Math.max(Date.now(), expectedDate.getTime() + 1));

      const result = await tx.invoice.updateMany({
        where: { id: invoiceId, organizationId, project: { organizationId }, status: "DRAFT", updatedAt: expectedDate },
        data: {
          invoiceNumber: values.invoiceNumber,
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
          clientId: project.clientId,
          organizationId,
          updatedAt: nextUpdatedAt,
        },
      });

      if (result.count === 0) {
        return { status: "conflict" as const };
      }

      if (values.mode === "itemized") {
        await tx.invoiceLineItem.deleteMany({ where: { invoiceId } });
        await tx.invoiceLineItem.createMany({
          data: calc.lineItems.map((lineItem, index) => ({
            invoiceId,
            description: lineItem.description,
            quantity: lineItem.quantity,
            unitPrice: lineItem.unitPrice,
            lineTotal: lineItem.lineTotal,
            position: index,
          })),
        });
      } else if (existing.lineItems.length > 0) {
        await tx.invoiceLineItem.deleteMany({ where: { invoiceId } });
      }

      await createActivity(tx, {
        organizationId,
        actorId: user.id,
        entityType: "INVOICE",
        entityId: invoiceId,
        action: "UPDATED",
        metadata: buildInvoiceUpdatedMetadata(values.invoiceNumber, changedFields, project.name, user.name),
      });

      return { status: "updated" as const };
    });

    if (outcome.status === "not_found") {
      return { error: "This invoice could not be found." };
    }
    if (outcome.status === "conflict") {
      return { error: "This invoice was changed elsewhere — please refresh and try again." };
    }
    if (outcome.status === "noop") {
      toastMessage = "No changes to save";
    }
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

  redirect(withToast("/invoices", toastMessage));
}
