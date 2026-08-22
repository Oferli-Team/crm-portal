import { formatStatusLabel } from "@/lib/format";

/**
 * Invoice System Slice 2b — the Invoice-specific status label override
 * (docs/invoicing-architecture.md §3.1: "The UI label is 'Issued'" for
 * the SENT enum value — the enum value itself stays SENT, zero
 * schema/migration churn for a label change).
 *
 * Accepts a plain `string` (not narrowed to InvoiceStatus) so it can be
 * safely applied at metadata-driven call sites (Activity/Notification
 * formatters, where the value is untyped JSON), not just at typed badge
 * call sites.
 */
const INVOICE_STATUS_LABEL_OVERRIDES: Readonly<Partial<Record<string, string>>> = {
  SENT: "Issued",
};

export function formatInvoiceStatusLabel(status: string): string {
  return INVOICE_STATUS_LABEL_OVERRIDES[status] ?? formatStatusLabel(status);
}
