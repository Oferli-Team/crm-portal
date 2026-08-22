import type { InvoiceFormState } from "@/types";
import { parseDateOnly } from "@/lib/invoices/date-only";
import { isSupportedInvoiceCurrency } from "@/lib/invoices/currencies";
import { decodeInvoiceLineItemsFormValue, type InvoiceLineItemFormValue } from "@/lib/invoices/line-items-form";
import type { InvoiceCalculationError } from "@/lib/invoices/calculations";

export const INVOICE_STATUSES = [
  "DRAFT",
  "SENT",
  "PAID",
  "OVERDUE",
  "CANCELLED",
] as const;
export type InvoiceStatusValue = (typeof INVOICE_STATUSES)[number];

export const INVOICE_MODES = ["flat", "itemized"] as const;
export type InvoiceModeValue = (typeof INVOICE_MODES)[number];

export const INVOICE_DISCOUNT_TYPES = ["NONE", "PERCENTAGE", "FIXED"] as const;
export type InvoiceDiscountTypeValue = (typeof INVOICE_DISCOUNT_TYPES)[number];

export const INVOICE_TAX_LABELS = ["TAX", "VAT", "GST"] as const;
export type InvoiceTaxLabelValue = (typeof INVOICE_TAX_LABELS)[number];

/**
 * No existing DB or app-level cap exists for Invoice.notes/internalNotes
 * (String?, unbounded in Postgres). Adopts the same cap this codebase
 * already uses for its closest precedent — a long free-text field —
 * COMMENT_BODY_MAX_LENGTH (src/lib/comments/validate-body.ts).
 */
export const INVOICE_NOTES_MAX_LENGTH = 10_000;

/**
 * Invoice System Slice 2b (docs/invoicing-architecture.md §5/§14 Slice 2).
 * The complete parsed shape of a validated DRAFT create/edit submission.
 * `status` is deliberately absent — never a submitted field on this form.
 */
export type ParsedInvoiceValues = {
  mode: "flat" | "itemized";
  invoiceNumber: string;
  projectId: string;
  /** Present only when mode === "flat" — ignored/never read otherwise. */
  amount: string | null;
  /** Present only when mode === "itemized" — ignored/never read otherwise. */
  lineItems: InvoiceLineItemFormValue[] | null;
  currency: string;
  issueDate: Date;
  dueDate: Date | null;
  notes: string | null;
  internalNotes: string | null;
  discountType: InvoiceDiscountTypeValue;
  discountValue: string | null;
  taxRatePercent: string | null;
  taxLabel: InvoiceTaxLabelValue;
};

export type ParseInvoiceFormResult =
  | { ok: true; values: ParsedInvoiceValues }
  | {
      ok: false;
      fieldErrors: NonNullable<InvoiceFormState["fieldErrors"]>;
      lineItemErrors?: InvoiceFormState["lineItemErrors"];
    };

/**
 * The single gate every Invoice create/edit Server Action must check
 * before authenticating, querying, or writing anything — checks BOTH
 * error collections, never fieldErrors alone (a shape-invalid line item
 * produces only a lineItemErrors entry and must still stop the action).
 */
export function hasInvoiceFormErrors(
  fieldErrors: InvoiceFormState["fieldErrors"],
  lineItemErrors: InvoiceFormState["lineItemErrors"],
): boolean {
  return Boolean(
    (fieldErrors && Object.keys(fieldErrors).length > 0) ||
      (lineItemErrors && Object.keys(lineItemErrors).length > 0),
  );
}

function mergeLineItemError(
  existing: InvoiceFormState["lineItemErrors"],
  index: number,
  error: Partial<Record<"description" | "quantity" | "unitPrice", string>>,
): NonNullable<InvoiceFormState["lineItemErrors"]> {
  return { ...(existing ?? {}), [index]: { ...(existing?.[index] ?? {}), ...error } };
}

/**
 * Parses and validates a DRAFT create/edit FormData submission into a
 * discriminated result. `status`/identity/total/position/id fields are
 * never read from `formData` at all — there is no code path here that
 * could accidentally trust one, since the parser never looks for them.
 */
export function parseInvoiceForm(formData: FormData): ParseInvoiceFormResult {
  const modeRaw = String(formData.get("mode") ?? "");

  const invoiceNumber = String(formData.get("invoiceNumber") ?? "").trim();
  const projectId = String(formData.get("projectId") ?? "").trim();
  const amountRaw = String(formData.get("amount") ?? "").trim();
  const lineItemsRaw = String(formData.get("lineItems") ?? "");
  const currencyRaw = String(formData.get("currency") ?? "").trim().toUpperCase();
  const issueDateRaw = String(formData.get("issueDate") ?? "").trim();
  const dueDateRaw = String(formData.get("dueDate") ?? "").trim();
  const notesRaw = String(formData.get("notes") ?? "").trim();
  const internalNotesRaw = String(formData.get("internalNotes") ?? "").trim();
  const discountTypeRaw = String(formData.get("discountType") ?? "NONE");
  const discountValueRaw = String(formData.get("discountValue") ?? "").trim();
  const taxRatePercentRaw = String(formData.get("taxRatePercent") ?? "").trim();
  const taxLabelRaw = String(formData.get("taxLabel") ?? "TAX");

  const fieldErrors: NonNullable<InvoiceFormState["fieldErrors"]> = {};
  let lineItemErrors: InvoiceFormState["lineItemErrors"];

  if (!invoiceNumber) {
    fieldErrors.invoiceNumber = "Invoice number is required.";
  }
  if (!projectId) {
    fieldErrors.projectId = "Select a project.";
  }

  // Only the exact runtime values "flat"/"itemized" are accepted — a
  // missing, empty, differently-cased, or forged value (e.g. "bogus") is
  // rejected, never silently mapped to "flat". The "flat" fallback below
  // exists solely so the rest of this function can finish building a
  // well-typed rejected result (mirroring discountType/taxLabel's own
  // fallback pattern) — it never makes `ok` true when mode was invalid.
  const isValidMode = (INVOICE_MODES as readonly string[]).includes(modeRaw);
  if (!isValidMode) {
    fieldErrors.mode = "Select a valid invoice type.";
  }
  const mode: InvoiceModeValue = isValidMode ? (modeRaw as InvoiceModeValue) : "flat";

  // amount is parsed/used only in flat mode — an irrelevant submitted
  // value in itemized mode is simply never read.
  let amount: string | null = null;
  if (mode === "flat") {
    if (!amountRaw) {
      fieldErrors.amount = "Enter an amount.";
    } else {
      amount = amountRaw;
    }
  }

  // lineItems JSON is decoded/used only in itemized mode.
  let lineItems: InvoiceLineItemFormValue[] | null = null;
  if (mode === "itemized") {
    const decoded = decodeInvoiceLineItemsFormValue(lineItemsRaw);
    if (!decoded.ok) {
      switch (decoded.error.code) {
        case "PAYLOAD_TOO_LARGE":
          fieldErrors.lineItems = "This line-item list is too large.";
          break;
        case "MALFORMED_JSON":
        case "NOT_ARRAY":
          fieldErrors.lineItems = "Line items could not be read — please try again.";
          break;
        case "TOO_MANY_LINE_ITEMS":
          fieldErrors.lineItems = "You can add at most 200 line items.";
          break;
        case "INVALID_ITEM_SHAPE":
          lineItemErrors = mergeLineItemError(lineItemErrors, decoded.error.index, { description: "This line item is invalid." });
          break;
      }
    } else {
      lineItems = decoded.lineItems;
    }
  }

  if (!currencyRaw) {
    fieldErrors.currency = "Select a currency.";
  } else if (!isSupportedInvoiceCurrency(currencyRaw)) {
    fieldErrors.currency = "This currency isn't supported for invoices.";
  }

  let issueDate: Date | null = null;
  const issueDateParsed = parseDateOnly(issueDateRaw);
  if (!issueDateParsed.ok) {
    fieldErrors.issueDate = "Enter a valid issue date.";
  } else {
    issueDate = issueDateParsed.date;
  }

  let dueDate: Date | null = null;
  if (dueDateRaw) {
    const dueDateParsed = parseDateOnly(dueDateRaw);
    if (!dueDateParsed.ok) {
      fieldErrors.dueDate = "Enter a valid due date.";
    } else {
      dueDate = dueDateParsed.date;
    }
  }

  if (notesRaw.length > INVOICE_NOTES_MAX_LENGTH) {
    fieldErrors.notes = `Must be ${INVOICE_NOTES_MAX_LENGTH} characters or fewer.`;
  }
  if (internalNotesRaw.length > INVOICE_NOTES_MAX_LENGTH) {
    fieldErrors.internalNotes = `Must be ${INVOICE_NOTES_MAX_LENGTH} characters or fewer.`;
  }

  const isValidDiscountType = INVOICE_DISCOUNT_TYPES.includes(discountTypeRaw as InvoiceDiscountTypeValue);
  if (!isValidDiscountType) {
    fieldErrors.discountType = "Select a valid discount type.";
  }
  const discountType: InvoiceDiscountTypeValue = isValidDiscountType ? (discountTypeRaw as InvoiceDiscountTypeValue) : "NONE";

  let discountValue: string | null = null;
  if (discountType !== "NONE") {
    if (!discountValueRaw) {
      fieldErrors.discountValue = "Enter a discount value.";
    } else {
      discountValue = discountValueRaw;
    }
  }

  const taxRatePercent = taxRatePercentRaw === "" ? null : taxRatePercentRaw;

  const isValidTaxLabel = INVOICE_TAX_LABELS.includes(taxLabelRaw as InvoiceTaxLabelValue);
  if (!isValidTaxLabel) {
    fieldErrors.taxLabel = "Select a valid tax label.";
  }
  const taxLabel: InvoiceTaxLabelValue = isValidTaxLabel ? (taxLabelRaw as InvoiceTaxLabelValue) : "TAX";

  if (hasInvoiceFormErrors(fieldErrors, lineItemErrors) || issueDate === null) {
    return { ok: false, fieldErrors, lineItemErrors };
  }

  return {
    ok: true,
    values: {
      mode,
      invoiceNumber,
      projectId,
      amount,
      lineItems,
      currency: currencyRaw,
      issueDate,
      dueDate,
      notes: notesRaw || null,
      internalNotes: internalNotesRaw || null,
      discountType,
      discountValue,
      taxRatePercent,
      taxLabel,
    },
  };
}

/**
 * Maps every calculateInvoiceTotals() error code (Slice 2a,
 * src/lib/invoices/calculations.ts) to its exact scalar or indexed
 * row-error destination. TOTAL_OUT_OF_RANGE is the one mode-dependent
 * code — it names no single field, so it routes to `amount` in flat mode
 * and `lineItems` in itemized mode.
 */
export function mapInvoiceCalculationError(
  error: InvoiceCalculationError,
  mode: "flat" | "itemized",
): { fieldErrors?: NonNullable<InvoiceFormState["fieldErrors"]>; lineItemErrors?: InvoiceFormState["lineItemErrors"] } {
  switch (error.code) {
    case "EMPTY_LINE_ITEMS":
      return { fieldErrors: { lineItems: "Add at least one line item." } };
    case "TOO_MANY_LINE_ITEMS":
      return { fieldErrors: { lineItems: "You can add at most 200 line items." } };
    case "EMPTY_DESCRIPTION":
      return { lineItemErrors: { [error.index]: { description: "Enter a description." } } };
    case "DESCRIPTION_TOO_LONG":
      return { lineItemErrors: { [error.index]: { description: "Description is too long (max 500 characters)." } } };
    case "ZERO_OR_NEGATIVE_QUANTITY":
      return { lineItemErrors: { [error.index]: { quantity: "Enter a quantity greater than zero." } } };
    case "QUANTITY_TOO_PRECISE":
      return { lineItemErrors: { [error.index]: { quantity: "Quantity allows at most 3 decimal places." } } };
    case "QUANTITY_OUT_OF_RANGE":
      return { lineItemErrors: { [error.index]: { quantity: "Quantity is too large." } } };
    case "NEGATIVE_UNIT_PRICE":
      return { lineItemErrors: { [error.index]: { unitPrice: "Enter a unit price of zero or more." } } };
    case "UNIT_PRICE_TOO_PRECISE":
      return { lineItemErrors: { [error.index]: { unitPrice: "Unit price allows at most 2 decimal places." } } };
    case "UNIT_PRICE_OUT_OF_RANGE":
      return { lineItemErrors: { [error.index]: { unitPrice: "Unit price is too large." } } };
    case "INVALID_FLAT_AMOUNT":
      return { fieldErrors: { amount: "Enter a valid amount." } };
    case "DISCOUNT_PERCENTAGE_OUT_OF_RANGE":
      return { fieldErrors: { discountValue: "Enter a discount percentage between 0 and 100." } };
    case "DISCOUNT_VALUE_INVALID":
      return { fieldErrors: { discountValue: "Enter a valid discount amount." } };
    case "DISCOUNT_EXCEEDS_SUBTOTAL":
      return { fieldErrors: { discountValue: "Discount cannot exceed the subtotal." } };
    case "TAX_RATE_OUT_OF_RANGE":
      return { fieldErrors: { taxRatePercent: "Enter a tax rate between 0 and 100." } };
    case "TOTAL_OUT_OF_RANGE":
      return mode === "flat"
        ? { fieldErrors: { amount: "This invoice's total is out of range." } }
        : { fieldErrors: { lineItems: "This invoice's total is out of range." } };
  }
}
