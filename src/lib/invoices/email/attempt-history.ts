import "server-only";
import { prisma } from "@/lib/prisma";
import { assertCanAccessPaymentDetails } from "@/lib/organization-setup/authorization";
import type { TrustedInvoiceActor } from "@/lib/invoices/lifecycle";

export type InvoiceEmailAttemptSummary = {
  id: string;
  status: "PENDING" | "ACCEPTED" | "FAILED" | "UNKNOWN";
  recipientEmail: string;
  attemptedAt: Date;
};

export async function loadInvoiceEmailAttempts(
  actor: TrustedInvoiceActor,
  invoiceId: string,
): Promise<InvoiceEmailAttemptSummary[]> {
  assertCanAccessPaymentDetails(actor.role);
  return prisma.invoiceEmailAttempt.findMany({
    where: { invoiceId, invoice: { organizationId: actor.organizationId } },
    orderBy: [{ attemptedAt: "desc" }, { id: "desc" }],
    take: 20,
    select: { id: true, status: true, recipientEmail: true, attemptedAt: true },
  });
}
