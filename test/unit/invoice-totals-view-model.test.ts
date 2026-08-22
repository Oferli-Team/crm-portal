import { describe, expect, it } from "vitest";
import { buildInvoiceTotalsViewModel } from "@/lib/invoices/totals-view-model";

describe("buildInvoiceTotalsViewModel", () => {
  it("a fully-null legacy row falls back to amount for subtotal, and omits discount/tax rows", () => {
    const result = buildInvoiceTotalsViewModel({
      amount: "100.00",
      subtotal: null,
      discountType: "NONE",
      discountAmount: null,
      discountValue: null,
      taxRatePercent: null,
      taxAmount: null,
      taxLabel: "TAX",
      currency: "USD",
    });
    expect(result.displayedSubtotal).toBe("$100.00");
    expect(result.discountRow).toBeNull();
    expect(result.taxRow).toBeNull();
    expect(result.total).toBe("$100.00");
  });

  it("a Slice-1-backfilled flat row (subtotal === amount, zeroed discount/tax, NONE type) still omits both rows", () => {
    const result = buildInvoiceTotalsViewModel({
      amount: "250.00",
      subtotal: "250.00",
      discountType: "NONE",
      discountAmount: "0.00",
      discountValue: null,
      taxRatePercent: null,
      taxAmount: "0.00",
      taxLabel: "TAX",
      currency: "USD",
    });
    expect(result.displayedSubtotal).toBe("$250.00");
    expect(result.discountRow).toBeNull();
    expect(result.taxRow).toBeNull();
  });

  it("a real discounted and taxed invoice shows both rows with correct labels/amounts", () => {
    const result = buildInvoiceTotalsViewModel({
      amount: "830.24",
      subtotal: "922.49",
      discountType: "PERCENTAGE",
      discountAmount: "92.25",
      discountValue: "10",
      taxRatePercent: "8.25",
      taxAmount: "68.49",
      taxLabel: "VAT",
      currency: "USD",
    });
    expect(result.displayedSubtotal).toBe("$922.49");
    expect(result.discountRow).toEqual({ label: "Discount (10%)", amount: "$92.25" });
    expect(result.taxRow).toEqual({ label: "VAT (8.25%)", amount: "$68.49" });
    expect(result.total).toBe("$830.24");
  });

  it("a FIXED discount omits the percentage from its label", () => {
    const result = buildInvoiceTotalsViewModel({
      amount: "50.00",
      subtotal: "100.00",
      discountType: "FIXED",
      discountAmount: "50.00",
      discountValue: "50.00",
      taxRatePercent: null,
      taxAmount: null,
      taxLabel: "TAX",
      currency: "USD",
    });
    expect(result.discountRow).toEqual({ label: "Discount", amount: "$50.00" });
  });

  it("never fabricates a persisted zero value — discountAmount present but discountType NONE still omits the row", () => {
    // Defensive case: a hypothetical inconsistent row should still never
    // show a discount line implying a real discount was applied.
    const result = buildInvoiceTotalsViewModel({
      amount: "100.00",
      subtotal: "100.00",
      discountType: "NONE",
      discountAmount: "0.00",
      discountValue: null,
      taxRatePercent: null,
      taxAmount: null,
      taxLabel: "TAX",
      currency: "USD",
    });
    expect(result.discountRow).toBeNull();
  });
});
