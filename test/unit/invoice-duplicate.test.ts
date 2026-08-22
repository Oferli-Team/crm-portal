import { describe, expect, it } from "vitest";
import {
  suggestDuplicateInvoiceNumber,
  buildDuplicateInvoiceDefaults,
  type DuplicateSourceData,
} from "@/lib/invoices/duplicate";

describe("suggestDuplicateInvoiceNumber", () => {
  it("appends -R1 to a plain number", () => {
    expect(suggestDuplicateInvoiceNumber("INV-100")).toBe("INV-100-R1");
  });

  it("does not detect or increment an existing -R1 suffix — appends literally", () => {
    expect(suggestDuplicateInvoiceNumber("INV-100-R1")).toBe("INV-100-R1-R1");
  });

  it("does not detect or increment an existing -R2 suffix — appends literally", () => {
    expect(suggestDuplicateInvoiceNumber("INV-100-R2")).toBe("INV-100-R2-R1");
  });

  it("a non-terminal 'R5' substring is not treated as a revision suffix", () => {
    expect(suggestDuplicateInvoiceNumber("INV-R5-100")).toBe("INV-R5-100-R1");
  });

  it("a lowercase existing suffix is not recognized — appends literally", () => {
    expect(suggestDuplicateInvoiceNumber("inv-100-r1")).toBe("inv-100-r1-R1");
  });

  it("trims leading/trailing whitespace exactly once, then appends", () => {
    expect(suggestDuplicateInvoiceNumber("  INV-100  ")).toBe("INV-100-R1");
  });

  it("does not truncate a very long invoice number", () => {
    const long = "X".repeat(300);
    expect(suggestDuplicateInvoiceNumber(long)).toBe(`${long}-R1`);
  });

  it("an empty string deterministically becomes -R1 — no thrown error, no special-cased validation", () => {
    expect(suggestDuplicateInvoiceNumber("")).toBe("-R1");
  });
});

describe("buildDuplicateInvoiceDefaults", () => {
  const today = new Date("2026-08-17T12:00:00.000Z");

  function baseSource(overrides: Partial<DuplicateSourceData> = {}): DuplicateSourceData {
    return {
      invoiceNumber: "INV-100",
      projectId: "11111111-1111-4111-8111-111111111111",
      amount: "250.00",
      currency: "USD",
      notes: null,
      discountType: "NONE",
      discountValue: null,
      taxRatePercent: null,
      taxLabel: "TAX",
      lineItems: [],
      ...overrides,
    };
  }

  it("flat source: mode flat, amount copied, lineItems empty", () => {
    const result = buildDuplicateInvoiceDefaults(baseSource({ amount: "250.00", lineItems: [] }), today);
    expect(result.mode).toBe("flat");
    expect(result.amount).toBe("250.00");
    expect(result.lineItems).toEqual([]);
  });

  it("itemized source: mode itemized, amount is exactly empty string, ordered line items preserved", () => {
    const lineItems = [
      { description: "Design", quantity: "2", unitPrice: "50.00" },
      { description: "Hosting", quantity: "1", unitPrice: "29.99" },
    ];
    const result = buildDuplicateInvoiceDefaults(baseSource({ amount: "829.99", lineItems }), today);
    expect(result.mode).toBe("itemized");
    expect(result.amount).toBe("");
    expect(result.lineItems).toEqual(lineItems);
  });

  it("each itemized output line item contains only description/quantity/unitPrice", () => {
    const result = buildDuplicateInvoiceDefaults(
      baseSource({ lineItems: [{ description: "Design", quantity: "2", unitPrice: "50.00" }] }),
      today,
    );
    expect(Object.keys(result.lineItems[0]).sort()).toEqual(["description", "quantity", "unitPrice"].sort());
  });

  it("issueDate is formatDateOnly(today) for the exact injected Date, regardless of source", () => {
    const result = buildDuplicateInvoiceDefaults(baseSource(), today);
    expect(result.issueDate).toBe("2026-08-17");
  });

  it("a different injected today produces a different issueDate — proving no internal new Date() call", () => {
    const other = new Date("2020-01-01T00:00:00.000Z");
    const result = buildDuplicateInvoiceDefaults(baseSource(), other);
    expect(result.issueDate).toBe("2020-01-01");
  });

  it("dueDate always resets to blank", () => {
    const result = buildDuplicateInvoiceDefaults(baseSource(), today);
    expect(result.dueDate).toBe("");
  });

  it("internalNotes always resets to blank", () => {
    const result = buildDuplicateInvoiceDefaults(baseSource(), today);
    expect(result.internalNotes).toBe("");
  });

  it("notes null becomes blank", () => {
    const result = buildDuplicateInvoiceDefaults(baseSource({ notes: null }), today);
    expect(result.notes).toBe("");
  });

  it("notes present is copied unchanged", () => {
    const result = buildDuplicateInvoiceDefaults(baseSource({ notes: "Client-visible note" }), today);
    expect(result.notes).toBe("Client-visible note");
  });

  it("discountValue null becomes blank", () => {
    const result = buildDuplicateInvoiceDefaults(baseSource({ discountType: "PERCENTAGE", discountValue: null }), today);
    expect(result.discountValue).toBe("");
  });

  it("discountValue present is copied unchanged", () => {
    const result = buildDuplicateInvoiceDefaults(
      baseSource({ discountType: "PERCENTAGE", discountValue: "10" }),
      today,
    );
    expect(result.discountValue).toBe("10");
  });

  it("taxRatePercent null becomes blank", () => {
    const result = buildDuplicateInvoiceDefaults(baseSource({ taxRatePercent: null }), today);
    expect(result.taxRatePercent).toBe("");
  });

  it("taxRatePercent present is copied unchanged", () => {
    const result = buildDuplicateInvoiceDefaults(baseSource({ taxRatePercent: "8.25" }), today);
    expect(result.taxRatePercent).toBe("8.25");
  });

  it("invoiceNumber, projectId, discountType, taxLabel map correctly", () => {
    const result = buildDuplicateInvoiceDefaults(
      baseSource({
        invoiceNumber: "INV-42",
        projectId: "22222222-2222-4222-8222-222222222222",
        discountType: "FIXED",
        taxLabel: "VAT",
      }),
      today,
    );
    expect(result.invoiceNumber).toBe("INV-42-R1");
    expect(result.projectId).toBe("22222222-2222-4222-8222-222222222222");
    expect(result.discountType).toBe("FIXED");
    expect(result.taxLabel).toBe("VAT");
  });

  it("currency is passed through unchanged — canonicalization is the caller's responsibility, not this mapper's", () => {
    const result = buildDuplicateInvoiceDefaults(baseSource({ currency: " usd " }), today);
    expect(result.currency).toBe(" usd ");
  });
});
