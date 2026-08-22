import { describe, expect, it } from "vitest";
import { mapInvoiceCalculationError } from "@/lib/validation/invoice";
import type { InvoiceCalculationError } from "@/lib/invoices/calculations";

describe("mapInvoiceCalculationError", () => {
  it("EMPTY_LINE_ITEMS -> fieldErrors.lineItems", () => {
    expect(mapInvoiceCalculationError({ code: "EMPTY_LINE_ITEMS" }, "itemized")).toEqual({
      fieldErrors: { lineItems: expect.any(String) },
    });
  });

  it("TOO_MANY_LINE_ITEMS -> fieldErrors.lineItems", () => {
    expect(mapInvoiceCalculationError({ code: "TOO_MANY_LINE_ITEMS" }, "itemized")).toEqual({
      fieldErrors: { lineItems: expect.any(String) },
    });
  });

  const rowCases: { error: InvoiceCalculationError; field: "description" | "quantity" | "unitPrice" }[] = [
    { error: { code: "EMPTY_DESCRIPTION", index: 2 }, field: "description" },
    { error: { code: "DESCRIPTION_TOO_LONG", index: 2 }, field: "description" },
    { error: { code: "ZERO_OR_NEGATIVE_QUANTITY", index: 2 }, field: "quantity" },
    { error: { code: "QUANTITY_TOO_PRECISE", index: 2 }, field: "quantity" },
    { error: { code: "QUANTITY_OUT_OF_RANGE", index: 2 }, field: "quantity" },
    { error: { code: "NEGATIVE_UNIT_PRICE", index: 2 }, field: "unitPrice" },
    { error: { code: "UNIT_PRICE_TOO_PRECISE", index: 2 }, field: "unitPrice" },
    { error: { code: "UNIT_PRICE_OUT_OF_RANGE", index: 2 }, field: "unitPrice" },
  ];

  for (const { error, field } of rowCases) {
    it(`${error.code} -> lineItemErrors[index].${field}`, () => {
      const result = mapInvoiceCalculationError(error, "itemized");
      expect(result.lineItemErrors).toEqual({ 2: { [field]: expect.any(String) } });
    });
  }

  it("INVALID_FLAT_AMOUNT -> fieldErrors.amount", () => {
    expect(mapInvoiceCalculationError({ code: "INVALID_FLAT_AMOUNT" }, "flat")).toEqual({
      fieldErrors: { amount: expect.any(String) },
    });
  });

  it("DISCOUNT_PERCENTAGE_OUT_OF_RANGE -> fieldErrors.discountValue", () => {
    expect(mapInvoiceCalculationError({ code: "DISCOUNT_PERCENTAGE_OUT_OF_RANGE" }, "flat")).toEqual({
      fieldErrors: { discountValue: expect.any(String) },
    });
  });

  it("DISCOUNT_VALUE_INVALID -> fieldErrors.discountValue", () => {
    expect(mapInvoiceCalculationError({ code: "DISCOUNT_VALUE_INVALID" }, "flat")).toEqual({
      fieldErrors: { discountValue: expect.any(String) },
    });
  });

  it("DISCOUNT_EXCEEDS_SUBTOTAL -> fieldErrors.discountValue", () => {
    expect(mapInvoiceCalculationError({ code: "DISCOUNT_EXCEEDS_SUBTOTAL" }, "flat")).toEqual({
      fieldErrors: { discountValue: expect.any(String) },
    });
  });

  it("TAX_RATE_OUT_OF_RANGE -> fieldErrors.taxRatePercent", () => {
    expect(mapInvoiceCalculationError({ code: "TAX_RATE_OUT_OF_RANGE" }, "flat")).toEqual({
      fieldErrors: { taxRatePercent: expect.any(String) },
    });
  });

  it("TOTAL_OUT_OF_RANGE routes to amount in flat mode", () => {
    expect(mapInvoiceCalculationError({ code: "TOTAL_OUT_OF_RANGE" }, "flat")).toEqual({
      fieldErrors: { amount: expect.any(String) },
    });
  });

  it("TOTAL_OUT_OF_RANGE routes to lineItems in itemized mode", () => {
    expect(mapInvoiceCalculationError({ code: "TOTAL_OUT_OF_RANGE" }, "itemized")).toEqual({
      fieldErrors: { lineItems: expect.any(String) },
    });
  });
});
