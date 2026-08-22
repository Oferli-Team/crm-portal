import { Prisma } from "@/generated/prisma/browser";

// Invoice System Slice 2b (docs/invoicing-architecture.md §14 Slice 2).
// CREATED/DELETED share one enriched, null-safe snapshot builder;
// UPDATED is names-only (changed field names, never values); STATUS_CHANGED
// keeps its existing shape. notes/internalNotes and every line-item
// description/quantity/unitPrice value NEVER appear in any Invoice
// Activity metadata — only field names (for UPDATED) or a bare count (for
// CREATED/DELETED line items).

export type InvoiceTrackedLineItem = {
  description: string;
  quantity: unknown;
  unitPrice: unknown;
};

export type InvoiceTrackedSnapshot = {
  invoiceNumber: string;
  projectId: string;
  // Decimal on the "before" (DB) side, a Decimal or numeric string on the
  // "after" (calculation-result) side — compared via Prisma.Decimal,
  // never Number() (precision-lossy for large/precise decimals).
  amount: unknown;
  currency: string;
  issueDate: Date;
  dueDate: Date | null;
  notes: string | null;
  internalNotes: string | null;
  discountType: string;
  discountValue: unknown;
  taxRatePercent: unknown;
  taxLabel: string;
  lineItems: InvoiceTrackedLineItem[];
};

const INVOICE_TRACKED_FIELDS = [
  "invoiceNumber",
  "projectId",
  "amount",
  "currency",
  "issueDate",
  "dueDate",
  "notes",
  "internalNotes",
  "discountType",
  "discountValue",
  "taxRatePercent",
  "taxLabel",
  "lineItems",
] as const;

function toDecimalOrNull(value: unknown): InstanceType<typeof Prisma.Decimal> | null {
  if (value === null || value === undefined) return null;
  return Prisma.Decimal.isDecimal(value) ? value : new Prisma.Decimal(String(value));
}

/** Decimal equality, never Number() — a null on either side is only equal to a null on the other. */
function decimalEqual(a: unknown, b: unknown): boolean {
  const da = toDecimalOrNull(a);
  const db = toDecimalOrNull(b);
  if (da === null || db === null) return da === db;
  return da.equals(db);
}

function dateEqual(a: unknown, b: unknown): boolean {
  const at = a instanceof Date ? a.getTime() : null;
  const bt = b instanceof Date ? b.getTime() : null;
  return at === bt;
}

/**
 * Ordered line-item comparison. A length difference, a reorder, or any
 * single field difference on any row all collapse to "not equal" — the
 * caller (diffInvoiceFields) then reports exactly the one field name
 * "lineItems", never a per-row/per-field breakdown, and never the
 * description text itself (read here in memory for the comparison, never
 * emitted).
 */
function lineItemsEqual(a: InvoiceTrackedLineItem[], b: InvoiceTrackedLineItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].description !== b[i].description) return false;
    if (!decimalEqual(a[i].quantity, b[i].quantity)) return false;
    if (!decimalEqual(a[i].unitPrice, b[i].unitPrice)) return false;
  }
  return true;
}

function fieldEqual(field: (typeof INVOICE_TRACKED_FIELDS)[number], a: unknown, b: unknown): boolean {
  switch (field) {
    case "issueDate":
    case "dueDate":
      return dateEqual(a, b);
    case "amount":
    case "discountValue":
    case "taxRatePercent":
      return decimalEqual(a, b);
    case "lineItems":
      return lineItemsEqual(a as InvoiceTrackedLineItem[], b as InvoiceTrackedLineItem[]);
    default:
      return a === b;
  }
}

/**
 * Field names (never values) that differ between two Invoice snapshots.
 * `status` is deliberately not one of the tracked fields here — it is
 * always split out into its own STATUS_CHANGED event by the caller
 * (status-actions.ts), never listed in an UPDATED event's changedFields.
 */
export function diffInvoiceFields(before: InvoiceTrackedSnapshot, after: InvoiceTrackedSnapshot): string[] {
  return INVOICE_TRACKED_FIELDS.filter((field) => !fieldEqual(field, before[field], after[field]));
}

export type InvoiceSnapshotValue = {
  invoiceNumber: string;
  status: string;
  amount: unknown;
  currency: string;
  subtotal: unknown;
  discountType: string;
  discountAmount: unknown;
  taxRatePercent: unknown;
  taxAmount: unknown;
  taxLabel: string;
};

export type InvoiceSnapshotMetadata = {
  invoiceNumber: string;
  status: string;
  amount: string;
  currency: string;
  subtotal: string | null;
  discountType: string;
  discountAmount: string | null;
  taxRatePercent: string | null;
  taxAmount: string | null;
  taxLabel: string;
  lineItemCount: number;
  projectName: string;
  actorName: string;
};

function toStringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Shared by CREATED and DELETED — a full, safe structural/financial
 * snapshot (matching this codebase's existing convention of a real
 * snapshot for those two events, e.g. the Client billing-identity
 * precedent is names-only specifically for PII-adjacent fields; discount/
 * tax/amount are the same sensitivity class as `amount`, already shown
 * today). Every transitional field (subtotal/discountAmount/taxAmount) is
 * null-safe — never assumed non-null (Slice 5 owns that eventual
 * contract, not this builder). `lineItemCount` is a bare count, never the
 * line items' own description/quantity/unitPrice values. notes/
 * internalNotes are never included.
 */
export function buildInvoiceSnapshotMetadata(
  invoice: InvoiceSnapshotValue,
  lineItemCount: number,
  projectName: string,
  actorName: string,
): InvoiceSnapshotMetadata {
  return {
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    amount: String(invoice.amount),
    currency: invoice.currency,
    subtotal: toStringOrNull(invoice.subtotal),
    discountType: invoice.discountType,
    discountAmount: toStringOrNull(invoice.discountAmount),
    taxRatePercent: toStringOrNull(invoice.taxRatePercent),
    taxAmount: toStringOrNull(invoice.taxAmount),
    taxLabel: invoice.taxLabel,
    lineItemCount,
    projectName,
    actorName,
  };
}

export type InvoiceStatusChangedMetadata = {
  invoiceNumber: string;
  projectName: string;
  from: string;
  to: string;
  actorName: string;
};

/** Unchanged shape/event from before Slice 2b — reused verbatim by status-actions.ts. */
export function buildInvoiceStatusChangedMetadata(
  invoice: Pick<InvoiceSnapshotValue, "invoiceNumber">,
  projectName: string,
  from: string,
  to: string,
  actorName: string,
): InvoiceStatusChangedMetadata {
  return { invoiceNumber: invoice.invoiceNumber, projectName, from, to, actorName };
}

export type InvoiceUpdatedMetadata = {
  invoiceNumber: string;
  projectName: string;
  /** Field names only — e.g. ["currency", "lineItems", "internalNotes"]. Never a value, before or after. */
  changedFields: string[];
  actorName: string;
};

/** changedFields must already have "status" filtered out by the caller (diffInvoiceFields never includes it). */
export function buildInvoiceUpdatedMetadata(
  invoiceNumber: string,
  changedFields: string[],
  projectName: string,
  actorName: string,
): InvoiceUpdatedMetadata {
  return { invoiceNumber, projectName, changedFields, actorName };
}
