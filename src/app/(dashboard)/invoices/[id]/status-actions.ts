"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { createActivity } from "@/lib/activity/create-activity";
import { deliverNotificationEmails } from "@/lib/notifications/email/deliver-notification-email";
import { buildInvoiceStatusChangedMetadata } from "@/lib/activity/invoice-metadata";
import { isTransitionAllowed, computePaidAtUpdate } from "@/lib/invoices/lifecycle";
import { INVOICE_STATUSES, type InvoiceStatusValue } from "@/lib/validation/invoice";

export type ChangeInvoiceStatusResult =
  | { ok: true }
  | { ok: false; error: "NOT_FOUND" | "INVALID_STATUS" | "FORBIDDEN_TRANSITION" | "CONFLICT" };

/**
 * Invoice System Slice 2b — the one dedicated non-DRAFT lifecycle action
 * (docs/invoicing-architecture.md §3.1). `targetStatus` is deliberately a
 * plain `string`, not `InvoiceStatus` — a Server Action's parameters are
 * not runtime-type-checked at the boundary, so a forged/direct call could
 * pass any string; it is validated against the real INVOICE_STATUSES
 * allowlist before any DB access, never assumed.
 */
export async function changeInvoiceStatusAction(
  invoiceId: string,
  targetStatus: string,
): Promise<ChangeInvoiceStatusResult> {
  if (!INVOICE_STATUSES.includes(targetStatus as InvoiceStatusValue)) {
    return { ok: false, error: "INVALID_STATUS" };
  }
  const validatedTarget = targetStatus as InvoiceStatusValue;

  const { user, organizationId } = await getCurrentUserOrganization();

  const outcome = await prisma.$transaction(async (tx) => {
    const existing = await tx.invoice.findFirst({
      where: { id: invoiceId, organizationId, project: { organizationId } },
      include: { project: { select: { name: true } } },
    });
    if (!existing) return { status: "not_found" as const, notificationIds: [] as string[] };

    if (!isTransitionAllowed(existing.status, validatedTarget)) {
      return { status: "forbidden" as const, notificationIds: [] as string[] };
    }

    const paidAtUpdate = computePaidAtUpdate(existing.status === "PAID", validatedTarget === "PAID", new Date());

    // Guarded by the exact previously-read status — every allowed
    // transition changes `status` itself, so this closes the same-state
    // race the same way the DRAFT edit's updatedAt guard closes its own
    // (a concurrent winner's write changes `status`, so a loser's WHERE
    // evaluated against the post-commit row matches zero rows).
    const result = await tx.invoice.updateMany({
      where: { id: invoiceId, organizationId, project: { organizationId }, status: existing.status },
      data: { status: validatedTarget, ...paidAtUpdate },
    });
    if (result.count === 0) return { status: "conflict" as const, notificationIds: [] as string[] };

    const activity = await createActivity(tx, {
      organizationId,
      actorId: user.id,
      entityType: "INVOICE",
      entityId: invoiceId,
      action: "STATUS_CHANGED",
      metadata: buildInvoiceStatusChangedMetadata(existing, existing.project.name, existing.status, validatedTarget, user.name),
    });

    return { status: "ok" as const, notificationIds: activity.notificationIds };
  });

  if (outcome.status === "not_found") return { ok: false, error: "NOT_FOUND" };
  if (outcome.status === "forbidden") return { ok: false, error: "FORBIDDEN_TRANSITION" };
  if (outcome.status === "conflict") return { ok: false, error: "CONFLICT" };

  // Post-commit, best-effort, using the committed Notification ids — never
  // rolls back the transition if delivery fails.
  await deliverNotificationEmails(outcome.notificationIds);

  revalidatePath(`/invoices/${invoiceId}/edit`);
  revalidatePath("/invoices");
  return { ok: true };
}
