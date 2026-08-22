import { formatDateOnly } from "@/lib/invoices/date-only";
import type { InvoiceDiscountTypeValue, InvoiceTaxLabelValue } from "@/lib/validation/invoice";

/**
 * Invoice System — Duplicate-as-new-DRAFT (completing official Slice 2,
 * docs/invoicing-architecture.md §3.2/§14). Pure mapping only: no Prisma
 * import, no current-user/session import, no database access, no `new
 * Date()` internally — `today` is always an explicit, injected parameter
 * (the caller captures it once, matching the existing new-invoice page's
 * own `formatDateOnly(new Date())` convention). This keeps the module
 * genuinely deterministic and unit-testable without faking the system
 * clock, the same discipline `src/lib/invoices/lifecycle.ts`'s
 * `computePaidAtUpdate()` already established for an injected `now`.
 *
 * This module never decides currency support or normalization — its
 * caller (the duplicate page) passes an already-normalized, already-
 * supported currency in; `currency` here is passed through unchanged.
 */

export type DuplicateSourceLineItem = {
  description: string;
  quantity: string;
  unitPrice: string;
};

export type DuplicateSourceData = {
  invoiceNumber: string;
  projectId: string;
  amount: string;
  currency: string;
  notes: string | null;
  discountType: InvoiceDiscountTypeValue;
  discountValue: string | null;
  taxRatePercent: string | null;
  taxLabel: InvoiceTaxLabelValue;
  lineItems: DuplicateSourceLineItem[];
};

/**
 * Structurally compatible with InvoiceForm's own private
 * `InvoiceFormDefaults` type (src/components/invoices/invoice-form.tsx) —
 * deliberately NOT imported from there, since that type is private to a
 * Client Component and exporting it merely to satisfy this pure module
 * would invert the src/lib -> component dependency direction. Kept as an
 * independent, field-for-field-identical type here instead, matching this
 * codebase's own stated per-module-copy convention (see
 * src/lib/invoices/currencies.ts's identical rationale for its own
 * `Decimal` type alias).
 */
export type DuplicateInvoiceDefaults = {
  invoiceNumber: string;
  projectId: string;
  mode: "flat" | "itemized";
  amount: string;
  lineItems: DuplicateSourceLineItem[];
  currency: string;
  issueDate: string;
  dueDate: string;
  notes: string;
  internalNotes: string;
  discountType: InvoiceDiscountTypeValue;
  discountValue: string;
  taxRatePercent: string;
  taxLabel: InvoiceTaxLabelValue;
};

/**
 * The approved literal suggestion contract
 * (docs/invoicing-architecture.md §3.2): "the original number plus a -R1
 * revision suffix" — nothing more. Deliberately does NOT detect or
 * increment an existing "-R<n>" suffix, does NOT query for the next free
 * number, does NOT reserve anything, and does NOT truncate — this is a
 * suggestion only, always fully editable, never auto-submitted. Trimmed
 * once, then the literal suffix is appended; no other normalization.
 */
export function suggestDuplicateInvoiceNumber(original: string): string {
  return `${original.trim()}-R1`;
}

/**
 * Builds the complete DRAFT-form prefill from a CANCELLED source. `mode`
 * is derived purely from `source.lineItems.length` (matching the existing
 * edit page's own `invoice.lineItems.length > 0 ? "itemized" : "flat"`
 * rule). For an itemized source, the flat `amount` field is deliberately
 * `""` — the persisted aggregate total is never carried forward as dormant
 * client state; line items are the sole editable subtotal source, and the
 * server recomputes every total on submit regardless. `issueDate` always
 * resets to `today` (never the source's own issue date — this is a new
 * document, not a resurrection of the old one); `dueDate` and
 * `internalNotes` always reset blank.
 */
export function buildDuplicateInvoiceDefaults(source: DuplicateSourceData, today: Date): DuplicateInvoiceDefaults {
  const itemized = source.lineItems.length > 0;

  return {
    invoiceNumber: suggestDuplicateInvoiceNumber(source.invoiceNumber),
    projectId: source.projectId,
    mode: itemized ? "itemized" : "flat",
    amount: itemized ? "" : source.amount,
    lineItems: source.lineItems,
    currency: source.currency,
    issueDate: formatDateOnly(today),
    dueDate: "",
    notes: source.notes ?? "",
    internalNotes: "",
    discountType: source.discountType,
    discountValue: source.discountValue ?? "",
    taxRatePercent: source.taxRatePercent ?? "",
    taxLabel: source.taxLabel,
  };
}
