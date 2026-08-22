"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { createActivity } from "@/lib/activity/create-activity";
import { buildInvoiceUpdatedMetadata } from "@/lib/activity/invoice-metadata";
import { INVOICE_NOTES_MAX_LENGTH } from "@/lib/validation/invoice";

export type UpdateInvoiceInternalNotesResult =
  | { ok: true }
  | { ok: false; error: "NOT_FOUND" | "TOO_LONG" };

/**
 * Invoice System Slice 2b — internalNotes stays editable in every status
 * (docs/invoicing-architecture.md §3.3), via this dedicated action for
 * any non-DRAFT invoice (DRAFT uses the main edit form instead). No
 * updatedAt guard — last-write-wins, matching this codebase's universal
 * concurrency convention for non-status free-text fields (see the
 * corrected design's own investigation: no other plain text field in this
 * app carries an optimistic-concurrency guard).
 */
export async function updateInvoiceInternalNotesAction(
  invoiceId: string,
  internalNotesRaw: string,
): Promise<UpdateInvoiceInternalNotesResult> {
  const trimmed = internalNotesRaw.trim();
  if (trimmed.length > INVOICE_NOTES_MAX_LENGTH) {
    return { ok: false, error: "TOO_LONG" };
  }
  const nextValue = trimmed || null;

  const { user, organizationId } = await getCurrentUserOrganization();

  const outcome = await prisma.$transaction(async (tx) => {
    const existing = await tx.invoice.findFirst({
      where: { id: invoiceId, organizationId, project: { organizationId } },
      include: { project: { select: { name: true } } },
    });
    if (!existing) return { status: "not_found" as const };

    if ((existing.internalNotes ?? null) === nextValue) {
      return { status: "noop" as const };
    }

    const result = await tx.invoice.updateMany({
      where: { id: invoiceId, organizationId, project: { organizationId } },
      data: { internalNotes: nextValue },
    });
    if (result.count === 0) return { status: "not_found" as const };

    await createActivity(tx, {
      organizationId,
      actorId: user.id,
      entityType: "INVOICE",
      entityId: invoiceId,
      action: "UPDATED",
      // changedFields: ["internalNotes"] only — the value itself never
      // enters metadata, and this event never notifies anyone (INVOICE/
      // UPDATED has no entry in notification-rules.ts's RULES table).
      metadata: buildInvoiceUpdatedMetadata(existing.invoiceNumber, ["internalNotes"], existing.project.name, user.name),
    });

    return { status: "updated" as const };
  });

  if (outcome.status === "not_found") return { ok: false, error: "NOT_FOUND" };

  revalidatePath(`/invoices/${invoiceId}/edit`);
  return { ok: true };
}
