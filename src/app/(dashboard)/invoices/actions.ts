"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { createActivity } from "@/lib/activity/create-activity";
import { buildInvoiceSnapshotMetadata } from "@/lib/activity/invoice-metadata";
import { deleteAttachmentsForParent, cleanupAttachmentStorageObjects } from "@/lib/attachments/attachment-mutations";

export type DeleteInvoiceResult =
  | { ok: true }
  | { ok: false; error: "NOT_FOUND_OR_NOT_DRAFT" | "CONFLICT" };

/**
 * Invoice System Slice 2b — a non-DRAFT invoice may never be deleted;
 * every finalized invoice is a permanent historical record
 * (docs/invoicing-architecture.md §3.1). Both the snapshot read and the
 * guarded delete carry `status: "DRAFT"` in their predicate.
 */
export async function deleteInvoiceAction(invoiceId: string): Promise<DeleteInvoiceResult> {
  const { user, organizationId } = await getCurrentUserOrganization();

  // Delete, its Activity row, and Attachment cleanup are one atomic unit —
  // a failed Activity/Attachment insert rolls everything back together.
  const outcome = await prisma.$transaction(async (tx) => {
    // Snapshot taken before deletion — Activity.entityId is not a foreign
    // key, so this row (and its metadata) is what keeps the entry readable
    // once the Invoice row itself is gone. _count.lineItems, never the
    // full line-item rows, is all DELETED metadata ever needs.
    const existing = await tx.invoice.findFirst({
      where: { id: invoiceId, organizationId, project: { organizationId }, status: "DRAFT" },
      include: { project: { select: { name: true } }, _count: { select: { lineItems: true } } },
    });

    if (!existing) {
      return { ok: false as const, error: "NOT_FOUND_OR_NOT_DRAFT" as const };
    }

    const result = await tx.invoice.deleteMany({
      where: { id: invoiceId, organizationId, project: { organizationId }, status: "DRAFT" },
    });

    if (result.count === 0) {
      return { ok: false as const, error: "CONFLICT" as const };
    }

    await createActivity(tx, {
      organizationId,
      actorId: user.id,
      entityType: "INVOICE",
      entityId: invoiceId,
      action: "DELETED",
      metadata: buildInvoiceSnapshotMetadata(existing, existing._count.lineItems, existing.project.name, user.name),
    });

    const { storagePaths } = await deleteAttachmentsForParent(tx, {
      organizationId,
      actorId: user.id,
      actorName: user.name,
      targets: [{ entityType: "INVOICE", entityId: invoiceId, parentEntityLabel: existing.invoiceNumber }],
    });

    return { ok: true as const, storagePaths };
  });

  if (!outcome.ok) {
    // No Storage call at all — the guarded database deletion never
    // succeeded, so there is nothing to clean up.
    return outcome;
  }

  await cleanupAttachmentStorageObjects(outcome.storagePaths);

  revalidatePath("/invoices");
  return { ok: true };
}
