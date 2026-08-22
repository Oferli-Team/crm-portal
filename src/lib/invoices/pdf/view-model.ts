import "server-only";
import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma/browser";
import type { InvoiceDiscountType, InvoiceTaxLabel } from "@/generated/prisma/browser";
import { formatInvoiceCurrencyAmount } from "@/lib/invoices/currencies";
import { formatDateOnlyForDisplay } from "@/lib/invoices/date-only";
import { buildInvoiceTotalsViewModel, type InvoiceTotalsInput, type InvoiceTotalsViewModel } from "@/lib/invoices/totals-view-model";
import type { InvoiceCalculationResult } from "@/lib/invoices/calculations";
import type { AllowedLogoContentType, InvoiceIssuerSnapshotV1, InvoiceRecipientSnapshotV1 } from "./snapshot-types";

/**
 * Invoice System Official Slice 3, sub-PR 3a — the immutable PDF's
 * renderer-safe view model ("Second Corrected Design Report" §7). This
 * module is Node-only (it builds `Buffer`-backed data URIs) but carries no
 * secret of its own — `import "server-only"` is present per this sub-PR's
 * explicit scope, not because a bare Node-only marker would be
 * insufficient on its own.
 *
 * CRITICAL BOUNDARY: `InvoicePdfViewModel` and its nested presentation
 * types are the ONLY shape `document.tsx` ever receives. They are built
 * here, once, from a persisted `InvoiceIssuerSnapshotV1`/
 * `InvoiceRecipientSnapshotV1` (which DO carry Storage provenance) via an
 * explicit mapping step that structurally drops that provenance — the
 * renderer-safe types below have no field capable of holding a Storage
 * bucket, path, SHA-256, provider/public/signed URL, internal ID, raw
 * error, or `internalNotes`. This is a compile-time guarantee, not a
 * runtime scrub: it is enforced by these types simply never declaring
 * such a field, not by an omission-and-hope step.
 */

const PDF_LOCALE = "en-US";

type Decimal = InstanceType<typeof Prisma.Decimal>;
type MoneyValue = Decimal | string | number;

function formatMoney(value: MoneyValue, currency: string): string {
  return formatInvoiceCurrencyAmount(value, currency, PDF_LOCALE) ?? String(value);
}

// ---------------------------------------------------------------------------
// Renderer-safe presentation types — the only shapes document.tsx accepts.
// ---------------------------------------------------------------------------

export type InvoicePdfAddress = {
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
};

export type InvoicePdfPaymentInstructions = {
  bankName: string;
  accountHolder: string;
  accountNumber: string;
  swiftBic: string;
  paymentInstructions: string | null;
} | null;

export type InvoicePdfIssuerPresentation = {
  legalName: string;
  address: InvoicePdfAddress;
  country: string | null;
  taxId: string | null;
  supportEmail: string | null;
  phone: string | null;
  website: string | null;
  brandColor: string | null;
  payment: InvoicePdfPaymentInstructions;
  /** Already-validated logo bytes, inlined as a data URI — never a bucket/path/URL of any kind. */
  logoImage: { dataUri: string } | null;
};

export type InvoicePdfRecipientPresentation = {
  billingName: string;
  email: string | null;
  address: InvoicePdfAddress;
  country: string | null;
  taxId: string | null;
};

export type InvoicePdfLineItem = {
  description: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
};

/**
 * `documentStatus` is always an explicit, server-derived value supplied by
 * the caller — never read from any `Invoice.status` field embedded in this
 * type, because no such field exists here. At Issue time the source row
 * is still genuinely DRAFT in the database (the DB transition to SENT
 * only happens after rendering completes) — the caller must pass the
 * literal target status ("SENT") explicitly; this type has no way to
 * "blindly copy" a DRAFT value because it never accepts one.
 */
export type InvoicePdfViewModel = {
  documentStatus: "SENT" | "PAID" | "OVERDUE" | "CANCELLED";
  invoiceNumber: string;
  currency: string;
  issueDateDisplay: string;
  dueDateDisplay: string | null;
  issuer: InvoicePdfIssuerPresentation;
  recipient: InvoicePdfRecipientPresentation;
  lineItems: InvoicePdfLineItem[];
  /** True only for the single synthetic "Services" row case — never persisted as a real InvoiceLineItem row. */
  isFlatSynthetic: boolean;
  totals: InvoiceTotalsViewModel;
  notes: string | null;
};

// ---------------------------------------------------------------------------
// Mapping: persisted snapshot -> renderer-safe presentation.
// ---------------------------------------------------------------------------

export type RendererIssuerPresentationResult =
  | { ok: true; presentation: InvoicePdfIssuerPresentation }
  | { ok: false; reason: "LOGO_PROVENANCE_MISMATCH" };

/**
 * Enforces that `logoBytes` (already-fetched, already-validated bytes) is
 * exactly what `snapshot.logo`'s provenance record claims — never embeds a
 * logo the snapshot says wasn't included, never omits one the snapshot
 * says was, and never trusts a content-type/byte mismatch between what
 * was persisted and what's actually being rendered into this legal
 * document. `snapshot.logo.bucket`/`.path`/`.sha256` are read ONLY for
 * this consistency check — never copied into the returned presentation,
 * never rendered, never embedded in a URL. A mismatch is a hard failure
 * (`LOGO_PROVENANCE_MISMATCH`), never silently downgraded to "render
 * without a logo and continue" — the caller (the future Issue/Legacy
 * service) is responsible for mapping this to a safe internal error
 * before any render/upload proceeds.
 */
export function toRendererIssuerPresentation(
  snapshot: InvoiceIssuerSnapshotV1,
  logoBytes: { data: Buffer; contentType: AllowedLogoContentType } | null,
): RendererIssuerPresentationResult {
  let logoImage: { dataUri: string } | null = null;

  if (snapshot.logo.included) {
    if (logoBytes === null) {
      return { ok: false, reason: "LOGO_PROVENANCE_MISMATCH" };
    }
    if (logoBytes.contentType !== snapshot.logo.contentType) {
      return { ok: false, reason: "LOGO_PROVENANCE_MISMATCH" };
    }
    // Computed from the exact Buffer being embedded — node:crypto only,
    // no new dependency — and compared against the persisted provenance's
    // own hash, never trusted merely because a contentType matched.
    const computedSha256 = createHash("sha256").update(logoBytes.data).digest("hex");
    if (computedSha256 !== snapshot.logo.sha256) {
      return { ok: false, reason: "LOGO_PROVENANCE_MISMATCH" };
    }
    logoImage = { dataUri: `data:${logoBytes.contentType};base64,${logoBytes.data.toString("base64")}` };
  } else if (logoBytes !== null) {
    return { ok: false, reason: "LOGO_PROVENANCE_MISMATCH" };
  }

  return {
    ok: true,
    presentation: {
      legalName: snapshot.legalName,
      address: { ...snapshot.address },
      country: snapshot.country,
      taxId: snapshot.taxId,
      supportEmail: snapshot.supportEmail,
      phone: snapshot.phone,
      website: snapshot.website,
      brandColor: snapshot.brandColor,
      payment: snapshot.payment ? { ...snapshot.payment } : null,
      logoImage,
    },
  };
}

export function toRendererRecipientPresentation(snapshot: InvoiceRecipientSnapshotV1): InvoicePdfRecipientPresentation {
  return {
    billingName: snapshot.billingName,
    email: snapshot.email,
    address: { ...snapshot.address },
    country: snapshot.country,
    taxId: snapshot.taxId,
  };
}

// ---------------------------------------------------------------------------
// The main view-model builder.
// ---------------------------------------------------------------------------

/**
 * The single successful result of calling the authoritative
 * `calculateInvoiceTotals()` — never a second, independently-supplied
 * `lineItems`/`flatAmount`/`totals` set that could disagree with it. This
 * builder performs presentation formatting only; it never calls
 * `calculateInvoiceTotals()` itself. The Issue service
 * (src/lib/invoices/pdf/issue-invoice.ts) and the future Legacy Archive
 * service are each responsible for calling the authoritative calculator
 * exactly once and passing its one successful result here.
 */
export type SuccessfulInvoiceCalculation = Extract<InvoiceCalculationResult, { ok: true }>;

export type InvoicePdfBuildInput = {
  /** Explicit, server-derived target status — see InvoicePdfViewModel's own header comment. Never derived from any source row's own `.status`. */
  documentStatus: "SENT" | "PAID" | "OVERDUE" | "CANCELLED";
  invoiceNumber: string;
  issueDate: Date;
  dueDate: Date | null;
  currency: string;
  /**
   * The one, authoritative calculation. A flat invoice is identified only
   * by `calculation.lineItems.length === 0` — its synthetic "Services" row
   * uses `calculation.subtotal` as both unit price and line total, never a
   * separately-supplied amount. Itemized rows, per-line totals, subtotal,
   * discount amount, tax amount, and the final total all come only from
   * this one object — there is no other way for a caller to supply any of
   * them, so a forged/inconsistent PDF input is not structurally
   * expressible.
   */
  calculation: SuccessfulInvoiceCalculation;
  /** Presentation-label inputs only (e.g. "Discount (10%)") — reused unchanged by buildInvoiceTotalsViewModel(); never fed back into any arithmetic. */
  discountType: InvoiceDiscountType;
  discountValue: MoneyValue | null;
  taxRatePercent: MoneyValue | null;
  taxLabel: InvoiceTaxLabel;
  notes: string | null;
  issuer: InvoicePdfIssuerPresentation;
  recipient: InvoicePdfRecipientPresentation;
};

export function buildInvoicePdfViewModel(input: InvoicePdfBuildInput): InvoicePdfViewModel {
  const { calculation, currency } = input;
  const isFlatSynthetic = calculation.lineItems.length === 0;

  const lineItems: InvoicePdfLineItem[] = isFlatSynthetic
    ? [
        {
          description: "Services",
          quantity: "1",
          unitPrice: formatMoney(calculation.subtotal, currency),
          lineTotal: formatMoney(calculation.subtotal, currency),
        },
      ]
    : calculation.lineItems.map((item) => ({
        description: item.description,
        quantity: String(item.quantity),
        unitPrice: formatMoney(item.unitPrice, currency),
        lineTotal: formatMoney(item.lineTotal, currency),
      }));

  const totalsInput: InvoiceTotalsInput = {
    amount: calculation.total,
    subtotal: calculation.subtotal,
    discountType: input.discountType,
    discountAmount: calculation.discountAmount,
    discountValue: input.discountValue,
    taxRatePercent: input.taxRatePercent,
    taxAmount: calculation.taxAmount,
    taxLabel: input.taxLabel,
    currency,
  };

  return {
    documentStatus: input.documentStatus,
    invoiceNumber: input.invoiceNumber,
    currency,
    issueDateDisplay: formatDateOnlyForDisplay(input.issueDate, PDF_LOCALE),
    dueDateDisplay: input.dueDate ? formatDateOnlyForDisplay(input.dueDate, PDF_LOCALE) : null,
    issuer: input.issuer,
    recipient: input.recipient,
    lineItems,
    isFlatSynthetic,
    totals: buildInvoiceTotalsViewModel(totalsInput),
    notes: input.notes,
  };
}
