import type { PrismaClientOrTx } from "../types";

/**
 * Analytics Stage 1 (docs/analytics-architecture.md §5.3). The one count
 * `CompletionMetrics` needs that `OrganizationMetrics` doesn't already
 * have (task totals are reused from there — see the service layer) — a
 * single indexed `count` against `Invoice_status_idx`, never a second
 * full-table read.
 *
 * "Completed" for an invoice means `PAID` specifically — `CANCELLED`
 * invoices are excluded from both numerator and denominator by the
 * service layer's own call (it passes `totalInvoices - cancelledInvoices`
 * as the rate's denominator), since a cancelled invoice was never meant
 * to be paid and including it would make `invoiceCompletionRate` look
 * artificially low for an org that cancels stale drafts as routine
 * housekeeping.
 */
export async function getInvoiceCompletionCounts(
  client: PrismaClientOrTx,
  organizationId: string,
): Promise<{ paidInvoices: number; cancelledInvoices: number }> {
  const [paidInvoices, cancelledInvoices] = await Promise.all([
    client.invoice.count({ where: { organizationId, status: "PAID" } }),
    client.invoice.count({ where: { organizationId, status: "CANCELLED" } }),
  ]);

  return { paidInvoices, cancelledInvoices };
}
