import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// src/lib/invoices/pdf/view-model.ts imports the real "server-only"
// marker package — see test/unit/cron-auth.test.ts's own header comment
// for the identical precedent.
vi.mock("server-only", () => ({}));

import {
  buildInvoicePdfViewModel,
  toRendererIssuerPresentation,
  toRendererRecipientPresentation,
  type InvoicePdfBuildInput,
  type InvoicePdfIssuerPresentation,
  type InvoicePdfRecipientPresentation,
  type SuccessfulInvoiceCalculation,
} from "@/lib/invoices/pdf/view-model";
import { calculateInvoiceTotals, type InvoiceCalculationInput } from "@/lib/invoices/calculations";
import type { InvoiceIssuerSnapshotV1, InvoiceRecipientSnapshotV1 } from "@/lib/invoices/pdf/snapshot-types";

/** Test-only helper — real production code never does this; the future Issue/Legacy service calls calculateInvoiceTotals() itself and is expected to handle a failure, never to assume success. */
function mustCalculate(input: InvoiceCalculationInput): SuccessfulInvoiceCalculation {
  const result = calculateInvoiceTotals(input);
  if (!result.ok) throw new Error(`test fixture calculation failed: ${JSON.stringify(result.error)}`);
  return result;
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Strips the currency symbol and thousands separators an Intl-formatted amount carries (e.g. "$1,123.91") so it can be compared directly against a Decimal's own `.toFixed(2)` string. */
function normalizeDisplayedAmount(display: string): string {
  return display.replace(/[^0-9.-]/g, "");
}

const FLAT_CALCULATION = mustCalculate({
  subtotalSource: { mode: "flat", amount: "250.00" },
  discount: { type: "NONE" },
  taxRatePercent: null,
});

const ISSUER_PRESENTATION: InvoicePdfIssuerPresentation = {
  legalName: "Acme Corp",
  address: { streetAddress: "1 Main St", city: "Springfield", state: "IL", postalCode: "62701" },
  country: "US",
  taxId: "12-3456789",
  supportEmail: "support@acme.test",
  phone: null,
  website: null,
  brandColor: null,
  payment: null,
  logoImage: null,
};

const RECIPIENT_PRESENTATION: InvoicePdfRecipientPresentation = {
  billingName: "Jane Doe",
  email: "jane@example.test",
  address: { streetAddress: null, city: null, state: null, postalCode: null },
  country: null,
  taxId: null,
};

function baseInput(overrides: Partial<InvoicePdfBuildInput> = {}): InvoicePdfBuildInput {
  return {
    documentStatus: "SENT",
    invoiceNumber: "INV-100",
    issueDate: new Date("2026-08-17T00:00:00.000Z"),
    dueDate: new Date("2026-09-01T00:00:00.000Z"),
    currency: "USD",
    calculation: FLAT_CALCULATION,
    discountType: "NONE",
    discountValue: null,
    taxRatePercent: null,
    taxLabel: "TAX",
    notes: null,
    issuer: ISSUER_PRESENTATION,
    recipient: RECIPIENT_PRESENTATION,
    ...overrides,
  };
}

describe("buildInvoicePdfViewModel — documentStatus contract", () => {
  it("an explicit SENT documentStatus produces documentStatus SENT in the output, with no `status` field accepted anywhere in the input type", () => {
    const result = buildInvoicePdfViewModel(baseInput({ documentStatus: "SENT" }));
    expect(result.documentStatus).toBe("SENT");
  });

  it("a source object carrying an incidental DRAFT-shaped extra property never influences documentStatus — the builder never reads any such field", () => {
    const input = baseInput({ documentStatus: "SENT" });
    const result = buildInvoicePdfViewModel(input);
    expect(result.documentStatus).toBe("SENT");
    expect(result.documentStatus).not.toBe("DRAFT");
  });

  it.each(["SENT", "PAID", "OVERDUE", "CANCELLED"] as const)("legacy target status %s is preserved exactly", (status) => {
    const result = buildInvoicePdfViewModel(baseInput({ documentStatus: status }));
    expect(result.documentStatus).toBe(status);
  });

  it("does not mutate the input object", () => {
    // structuredClone() cannot clone a Prisma.Decimal instance (a class
    // with methods, not plain data) — JSON.stringify() works instead,
    // since decimal.js instances implement toJSON() (returning their own
    // string form), and comparing the SAME serialization taken before and
    // after sidesteps any Date/Decimal round-trip fidelity concerns
    // entirely: this only proves nothing changed, never that it matches
    // some independently-reconstructed object.
    const input = baseInput();
    const before = JSON.stringify(input);
    buildInvoicePdfViewModel(input);
    const after = JSON.stringify(input);
    expect(after).toBe(before);
  });

  it("does not mutate the input's nested issuer/recipient/calculation objects", () => {
    const input = baseInput();
    Object.freeze(input.issuer);
    Object.freeze(input.issuer.address);
    Object.freeze(input.recipient);
    Object.freeze(input.calculation);
    expect(() => buildInvoicePdfViewModel(input)).not.toThrow();
  });
});

describe("buildInvoicePdfViewModel — financial consistency (authoritative calculateInvoiceTotals() only)", () => {
  it("a flat calculation produces exactly one Services row", () => {
    const calculation = mustCalculate({
      subtotalSource: { mode: "flat", amount: "500.00" },
      discount: { type: "NONE" },
      taxRatePercent: null,
    });
    const result = buildInvoicePdfViewModel(baseInput({ calculation }));
    expect(result.isFlatSynthetic).toBe(true);
    expect(result.lineItems).toHaveLength(1);
    expect(result.lineItems[0].description).toBe("Services");
    expect(result.lineItems[0].quantity).toBe("1");
  });

  it("the Services row's unitPrice and lineTotal both equal the calculated subtotal", () => {
    const calculation = mustCalculate({
      subtotalSource: { mode: "flat", amount: "500.00" },
      discount: { type: "NONE" },
      taxRatePercent: null,
    });
    const result = buildInvoicePdfViewModel(baseInput({ calculation }));
    const expected = calculation.subtotal.toFixed(2);
    expect(result.lineItems[0].unitPrice).toContain(expected);
    expect(result.lineItems[0].lineTotal).toContain(expected);
    expect(result.lineItems[0].unitPrice).toBe(result.lineItems[0].lineTotal);
  });

  it("flat: subtotal/discount/tax/total in the resulting totals view model all originate from the same calculation result", () => {
    const calculation = mustCalculate({
      subtotalSource: { mode: "flat", amount: "500.00" },
      discount: { type: "PERCENTAGE", value: "10" },
      taxRatePercent: "8.25",
    });
    const result = buildInvoicePdfViewModel(
      baseInput({ calculation, discountType: "PERCENTAGE", discountValue: "10", taxRatePercent: "8.25" }),
    );
    expect(normalizeDisplayedAmount(result.totals.displayedSubtotal)).toBe(calculation.subtotal.toFixed(2));
    expect(normalizeDisplayedAmount(result.totals.discountRow!.amount)).toBe(calculation.discountAmount.toFixed(2));
    expect(normalizeDisplayedAmount(result.totals.taxRow!.amount)).toBe(calculation.taxAmount.toFixed(2));
    expect(normalizeDisplayedAmount(result.totals.total)).toBe(calculation.total.toFixed(2));
  });

  it("flat invoice with a fixed discount", () => {
    const calculation = mustCalculate({
      subtotalSource: { mode: "flat", amount: "500.00" },
      discount: { type: "FIXED", value: "50.00" },
      taxRatePercent: null,
    });
    expect(calculation.discountAmount.toFixed(2)).toBe("50.00");
    expect(calculation.total.toFixed(2)).toBe("450.00");
    const result = buildInvoicePdfViewModel(
      baseInput({ calculation, discountType: "FIXED", discountValue: "50.00" }),
    );
    expect(result.totals.discountRow!.amount).toContain("50.00");
    expect(result.totals.total).toContain("450.00");
  });

  it("itemized: displayed rows originate from calculation.lineItems, in order, with calculated per-line totals preserved", () => {
    const calculation = mustCalculate({
      subtotalSource: {
        mode: "lineItems",
        lineItems: [
          { description: "Design", quantity: "2", unitPrice: "50.00" },
          { description: "Hosting", quantity: "1", unitPrice: "29.99" },
          { description: "Support", quantity: "3", unitPrice: "10.00" },
        ],
      },
      discount: { type: "NONE" },
      taxRatePercent: null,
    });
    const result = buildInvoicePdfViewModel(baseInput({ calculation }));
    expect(result.isFlatSynthetic).toBe(false);
    expect(result.lineItems.map((li) => li.description)).toEqual(["Design", "Hosting", "Support"]);
    expect(normalizeDisplayedAmount(result.lineItems[0].lineTotal)).toBe(calculation.lineItems[0].lineTotal.toFixed(2));
    expect(normalizeDisplayedAmount(result.lineItems[1].lineTotal)).toBe(calculation.lineItems[1].lineTotal.toFixed(2));
    expect(normalizeDisplayedAmount(result.lineItems[2].lineTotal)).toBe(calculation.lineItems[2].lineTotal.toFixed(2));
  });

  it("itemized: multi-line with per-line rounding — the displayed subtotal equals the authoritative calculation subtotal, which is the sum of rounded per-line totals, not a re-derived figure", () => {
    const calculation = mustCalculate({
      subtotalSource: {
        mode: "lineItems",
        lineItems: [
          { description: "A", quantity: "3", unitPrice: "0.10" }, // 0.30
          { description: "B", quantity: "7", unitPrice: "0.33" }, // 2.31
          { description: "C", quantity: "1", unitPrice: "10.01" },
        ],
      },
      discount: { type: "NONE" },
      taxRatePercent: null,
    });
    const result = buildInvoicePdfViewModel(baseInput({ calculation }));
    expect(normalizeDisplayedAmount(result.totals.displayedSubtotal)).toBe(calculation.subtotal.toFixed(2));
  });

  it("itemized invoice with both discount and tax — discount/tax/final total match the authoritative result", () => {
    const calculation = mustCalculate({
      subtotalSource: {
        mode: "lineItems",
        lineItems: [
          { description: "Design", quantity: "10", unitPrice: "75.00" },
          { description: "Consulting", quantity: "4", unitPrice: "120.00" },
        ],
      },
      discount: { type: "PERCENTAGE", value: "15" },
      taxRatePercent: "7.5",
    });
    const result = buildInvoicePdfViewModel(
      baseInput({ calculation, discountType: "PERCENTAGE", discountValue: "15", taxRatePercent: "7.5" }),
    );
    expect(normalizeDisplayedAmount(result.totals.discountRow!.amount)).toBe(calculation.discountAmount.toFixed(2));
    expect(normalizeDisplayedAmount(result.totals.taxRow!.amount)).toBe(calculation.taxAmount.toFixed(2));
    expect(normalizeDisplayedAmount(result.totals.total)).toBe(calculation.total.toFixed(2));
  });

  it("a zero-value valid invoice (flat $0.00, no discount, no tax) renders a valid total of exactly $0.00", () => {
    const calculation = mustCalculate({
      subtotalSource: { mode: "flat", amount: "0.00" },
      discount: { type: "NONE" },
      taxRatePercent: null,
    });
    const result = buildInvoicePdfViewModel(baseInput({ calculation }));
    expect(result.totals.total).toContain("0.00");
    expect(result.lineItems[0].lineTotal).toContain("0.00");
  });

  it("never persists/returns a synthetic-line flag on itemized output", () => {
    const calculation = mustCalculate({
      subtotalSource: { mode: "lineItems", lineItems: [{ description: "Design", quantity: "1", unitPrice: "10.00" }] },
      discount: { type: "NONE" },
      taxRatePercent: null,
    });
    const result = buildInvoicePdfViewModel(baseInput({ calculation }));
    expect(result.isFlatSynthetic).toBe(false);
  });
});

describe("InvoicePdfBuildInput — structural exclusion of independently-suppliable financial fields", () => {
  it("has no top-level lineItems field (source-contract/type-level proof, not runtime-testable)", () => {
    const input = baseInput();
    // @ts-expect-error InvoicePdfBuildInput has no `lineItems` field — line items exist only inside `calculation`, which is the single, atomic, authoritative source
    input.lineItems = [{ description: "forged", quantity: "1", unitPrice: "1.00", lineTotal: "999999.99" }];
  });

  it("has no top-level flatAmount field (source-contract/type-level proof, not runtime-testable)", () => {
    const input = baseInput();
    // @ts-expect-error InvoicePdfBuildInput has no `flatAmount` field — a flat invoice's amount comes only from calculation.subtotal
    input.flatAmount = "999999.99";
  });

  it("has no top-level totals field (source-contract/type-level proof, not runtime-testable)", () => {
    const input = baseInput();
    // @ts-expect-error InvoicePdfBuildInput has no `totals` field — aggregate totals come only from calculation.{subtotal,discountAmount,taxAmount,total}
    input.totals = { amount: "1", subtotal: "1", discountType: "NONE", discountAmount: null, discountValue: null, taxRatePercent: null, taxAmount: null, taxLabel: "TAX", currency: "USD" };
  });

  it("the only financial-data field is `calculation`, bundling line items and aggregate totals atomically", () => {
    const input = baseInput();
    expect(Object.keys(input)).toContain("calculation");
    expect(Object.keys(input)).not.toContain("lineItems");
    expect(Object.keys(input)).not.toContain("flatAmount");
    expect(Object.keys(input)).not.toContain("totals");
  });
});

describe("buildInvoicePdfViewModel — deterministic en-US formatting", () => {
  it("formats currency amounts using en-US regardless of runtime default locale", () => {
    const calculation = mustCalculate({
      subtotalSource: { mode: "flat", amount: "1234.50" },
      discount: { type: "NONE" },
      taxRatePercent: null,
    });
    const result = buildInvoicePdfViewModel(baseInput({ calculation }));
    expect(result.totals.total).toBe("$1,234.50");
  });

  it("formats issueDate/dueDate deterministically (en-US, UTC-pinned)", () => {
    const result = buildInvoicePdfViewModel(
      baseInput({ issueDate: new Date("2026-08-17T00:00:00.000Z"), dueDate: new Date("2026-09-01T00:00:00.000Z") }),
    );
    expect(result.issueDateDisplay).toBe("8/17/2026");
    expect(result.dueDateDisplay).toBe("9/1/2026");
  });

  it("dueDateDisplay is null when dueDate is null", () => {
    const result = buildInvoicePdfViewModel(baseInput({ dueDate: null }));
    expect(result.dueDateDisplay).toBeNull();
  });
});

describe("buildInvoicePdfViewModel — discount/tax omission rules (reused from totals-view-model)", () => {
  it("omits the discount row when discountType is NONE", () => {
    const result = buildInvoicePdfViewModel(baseInput({ discountType: "NONE" }));
    expect(result.totals.discountRow).toBeNull();
  });

  it("includes the discount row when a discount is present", () => {
    const calculation = mustCalculate({
      subtotalSource: { mode: "flat", amount: "250.00" },
      discount: { type: "PERCENTAGE", value: "10" },
      taxRatePercent: null,
    });
    const result = buildInvoicePdfViewModel(
      baseInput({ calculation, discountType: "PERCENTAGE", discountValue: "10" }),
    );
    expect(result.totals.discountRow).toEqual({ label: "Discount (10%)", amount: "$25.00" });
  });

  it("omits the tax row when tax fields are null", () => {
    const result = buildInvoicePdfViewModel(baseInput());
    expect(result.totals.taxRow).toBeNull();
  });
});

describe("buildInvoicePdfViewModel — no storage provenance, no internalNotes in the resulting view model", () => {
  it("the resulting view model JSON never contains a bucket/path/sha256/provenance-shaped key", () => {
    const result = buildInvoicePdfViewModel(baseInput());
    const json = JSON.stringify(result);
    expect(json).not.toContain("bucket");
    expect(json).not.toContain("sha256");
    expect(json).not.toContain("storagePath");
    expect(json).not.toContain("pdfStoragePath");
  });

  it("the accepted input type has no internalNotes field at all (structural exclusion, not a runtime scrub)", () => {
    const input = baseInput();
    // @ts-expect-error internalNotes is not part of InvoicePdfBuildInput's type
    input.internalNotes = "should never be accepted";
    const result = buildInvoicePdfViewModel(input);
    expect(JSON.stringify(result)).not.toContain("should never be accepted");
  });
});

const VALID_LOGO_BYTES = Buffer.from("fake-png-bytes-for-testing");
const VALID_LOGO_SHA256 = sha256Hex(VALID_LOGO_BYTES);

function issuerSnapshotWithLogo(overrides: Partial<InvoiceIssuerSnapshotV1> = {}): InvoiceIssuerSnapshotV1 {
  return {
    schemaVersion: 1,
    legalName: "Acme Corp",
    address: { streetAddress: "1 Main St", city: "Springfield", state: "IL", postalCode: "62701" },
    country: "US",
    taxId: "12-3456789",
    supportEmail: "support@acme.test",
    phone: null,
    website: null,
    brandColor: "#336699",
    payment: { bankName: "Bank", accountHolder: "Holder", accountNumber: "123", swiftBic: "ABCD", paymentInstructions: null },
    logo: { included: true, bucket: "logos", path: "organizations/org-1/logo.png", contentType: "image/png", sha256: VALID_LOGO_SHA256 },
    ...overrides,
  };
}

describe("toRendererIssuerPresentation — logo provenance/render consistency", () => {
  it("included:false + null bytes -> success, no logo", () => {
    const snapshot = issuerSnapshotWithLogo({ logo: { included: false, reason: "no_logo_configured" } });
    const result = toRendererIssuerPresentation(snapshot, null);
    expect(result).toEqual({ ok: true, presentation: expect.objectContaining({ logoImage: null }) });
  });

  it("included:false + bytes present -> LOGO_PROVENANCE_MISMATCH", () => {
    const snapshot = issuerSnapshotWithLogo({ logo: { included: false, reason: "no_logo_configured" } });
    const result = toRendererIssuerPresentation(snapshot, { data: VALID_LOGO_BYTES, contentType: "image/png" });
    expect(result).toEqual({ ok: false, reason: "LOGO_PROVENANCE_MISMATCH" });
  });

  it("included:true + null bytes -> LOGO_PROVENANCE_MISMATCH", () => {
    const snapshot = issuerSnapshotWithLogo();
    const result = toRendererIssuerPresentation(snapshot, null);
    expect(result).toEqual({ ok: false, reason: "LOGO_PROVENANCE_MISMATCH" });
  });

  it("included:true + correct bytes/MIME/SHA -> success, with a rendered logoImage", () => {
    const snapshot = issuerSnapshotWithLogo();
    const result = toRendererIssuerPresentation(snapshot, { data: VALID_LOGO_BYTES, contentType: "image/png" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.presentation.logoImage).not.toBeNull();
      expect(result.presentation.logoImage!.dataUri.startsWith("data:image/png;base64,")).toBe(true);
    }
  });

  it("included:true + wrong MIME -> LOGO_PROVENANCE_MISMATCH", () => {
    const snapshot = issuerSnapshotWithLogo({ logo: { included: true, bucket: "logos", path: "x", contentType: "image/png", sha256: VALID_LOGO_SHA256 } });
    const result = toRendererIssuerPresentation(snapshot, { data: VALID_LOGO_BYTES, contentType: "image/jpeg" });
    expect(result).toEqual({ ok: false, reason: "LOGO_PROVENANCE_MISMATCH" });
  });

  it("included:true + wrong SHA -> LOGO_PROVENANCE_MISMATCH", () => {
    const snapshot = issuerSnapshotWithLogo({ logo: { included: true, bucket: "logos", path: "x", contentType: "image/png", sha256: "a".repeat(64) } });
    const result = toRendererIssuerPresentation(snapshot, { data: VALID_LOGO_BYTES, contentType: "image/png" });
    expect(result).toEqual({ ok: false, reason: "LOGO_PROVENANCE_MISMATCH" });
  });

  it("included:true + different bytes with the same expected MIME -> LOGO_PROVENANCE_MISMATCH (the SHA no longer matches)", () => {
    const snapshot = issuerSnapshotWithLogo(); // sha256 computed from VALID_LOGO_BYTES
    const differentBytes = Buffer.from("a completely different set of bytes");
    const result = toRendererIssuerPresentation(snapshot, { data: differentBytes, contentType: "image/png" });
    expect(result).toEqual({ ok: false, reason: "LOGO_PROVENANCE_MISMATCH" });
  });

  it("a successful result contains no bucket/path/sha256/URL of any kind", () => {
    const snapshot = issuerSnapshotWithLogo();
    const result = toRendererIssuerPresentation(snapshot, { data: VALID_LOGO_BYTES, contentType: "image/png" });
    expect(result.ok).toBe(true);
    const json = JSON.stringify(result);
    expect(json).not.toContain("bucket");
    expect(json).not.toContain("logos");
    expect(json).not.toContain(VALID_LOGO_SHA256);
    expect(json).not.toContain("http");
  });

  it("does not mutate the source snapshot or the input Buffer", () => {
    const snapshot = issuerSnapshotWithLogo();
    const snapshotBefore = structuredClone(snapshot);
    const bytes = Buffer.from(VALID_LOGO_BYTES); // independent copy
    const bytesBefore = Buffer.from(bytes);
    toRendererIssuerPresentation(snapshot, { data: bytes, contentType: "image/png" });
    expect(snapshot).toEqual(snapshotBefore);
    expect(bytes.equals(bytesBefore)).toBe(true);
  });

  it("carries over the visible fields unchanged on success", () => {
    const snapshot = issuerSnapshotWithLogo({ logo: { included: false, reason: "no_logo_configured" } });
    const result = toRendererIssuerPresentation(snapshot, null);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.presentation.legalName).toBe("Acme Corp");
      expect(result.presentation.payment).toEqual({ bankName: "Bank", accountHolder: "Holder", accountNumber: "123", swiftBic: "ABCD", paymentInstructions: null });
    }
  });
});

describe("toRendererRecipientPresentation", () => {
  it("carries over visible fields unchanged with no additional fields", () => {
    const snapshot: InvoiceRecipientSnapshotV1 = {
      schemaVersion: 1,
      billingName: "Jane Doe",
      email: "jane@example.test",
      address: { streetAddress: null, city: null, state: null, postalCode: null },
      country: null,
      taxId: null,
    };
    const presentation = toRendererRecipientPresentation(snapshot);
    expect(presentation).toEqual({
      billingName: "Jane Doe",
      email: "jane@example.test",
      address: { streetAddress: null, city: null, state: null, postalCode: null },
      country: null,
      taxId: null,
    });
  });
});
