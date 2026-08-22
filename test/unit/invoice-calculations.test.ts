import { describe, expect, it } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import {
  calculateInvoiceTotals,
  MAX_LINE_ITEMS,
  MAX_DESCRIPTION_LENGTH,
  type LineItemInput,
} from "@/lib/invoices/calculations";

function dec(value: string): string {
  return new Prisma.Decimal(value).toString();
}

describe("calculateInvoiceTotals", () => {
  describe("architecture worked examples (docs/invoicing-architecture.md §5)", () => {
    it("example 1: normal — total 898.73", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: {
          mode: "lineItems",
          lineItems: [
            { description: "Design work", quantity: "10.5", unitPrice: "85.00" },
            { description: "Hosting", quantity: "1", unitPrice: "29.99" },
          ],
        },
        discount: { type: "PERCENTAGE", value: "10" },
        taxRatePercent: "8.25",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.lineItems[0].lineTotal.toString()).toBe(dec("892.50"));
      expect(result.lineItems[1].lineTotal.toString()).toBe(dec("29.99"));
      expect(result.subtotal.toString()).toBe(dec("922.49"));
      expect(result.discountAmount.toString()).toBe(dec("92.25"));
      expect(result.taxAmount.toString()).toBe(dec("68.49"));
      expect(result.total.toString()).toBe(dec("898.73"));
    });

    it("example 2: ROUND_HALF_UP — 67.00 subtotal, 1.5% tax → 1.01, not 1.00", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "67.00" },
        discount: { type: "NONE" },
        taxRatePercent: "1.5",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.taxAmount.toString()).toBe(dec("1.01"));
      expect(result.total.toString()).toBe(dec("68.01"));
    });

    it("example 3: fully discounted — zero total is legal", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "50.00" },
        discount: { type: "FIXED", value: "50.00" },
        taxRatePercent: null,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.discountAmount.toString()).toBe(dec("50.00"));
      expect(result.total.toString()).toBe(dec("0"));
    });

    it("example 4: rejected — FIXED discount exceeding subtotal", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "50.00" },
        discount: { type: "FIXED", value: "60.00" },
        taxRatePercent: null,
      });

      expect(result).toEqual({ ok: false, error: { code: "DISCOUNT_EXCEEDS_SUBTOTAL" } });
    });
  });

  describe("subtotal source", () => {
    it("flat source: subtotal equals amount, zero line items", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "199.99" },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.subtotal.toString()).toBe(dec("199.99"));
      expect(result.lineItems).toEqual([]);
      expect(result.total.toString()).toBe(dec("199.99"));
    });

    it("empty itemized source is rejected", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "lineItems", lineItems: [] },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result).toEqual({ ok: false, error: { code: "EMPTY_LINE_ITEMS" } });
    });

    it("invalid flat amount (negative) is rejected", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "-1.00" },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result).toEqual({ ok: false, error: { code: "INVALID_FLAT_AMOUNT" } });
    });

    it("invalid flat amount (non-numeric string) is rejected", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "not-a-number" },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result).toEqual({ ok: false, error: { code: "INVALID_FLAT_AMOUNT" } });
    });
  });

  describe("line-item count boundary", () => {
    function makeLineItems(count: number): LineItemInput[] {
      return Array.from({ length: count }, (_, i) => ({
        description: `Item ${i}`,
        quantity: "1",
        unitPrice: "1.00",
      }));
    }

    it(`accepts exactly ${MAX_LINE_ITEMS} line items`, () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "lineItems", lineItems: makeLineItems(MAX_LINE_ITEMS) },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.lineItems).toHaveLength(MAX_LINE_ITEMS);
      expect(result.subtotal.toString()).toBe(dec(String(MAX_LINE_ITEMS)));
    });

    it(`rejects ${MAX_LINE_ITEMS + 1} line items`, () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "lineItems", lineItems: makeLineItems(MAX_LINE_ITEMS + 1) },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result).toEqual({ ok: false, error: { code: "TOO_MANY_LINE_ITEMS" } });
    });
  });

  describe("description validation", () => {
    it("rejects a blank description", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "lineItems", lineItems: [{ description: "   ", quantity: "1", unitPrice: "1.00" }] },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result).toEqual({ ok: false, error: { code: "EMPTY_DESCRIPTION", index: 0 } });
    });

    it("rejects an overlong description", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: {
          mode: "lineItems",
          lineItems: [{ description: "x".repeat(MAX_DESCRIPTION_LENGTH + 1), quantity: "1", unitPrice: "1.00" }],
        },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result).toEqual({ ok: false, error: { code: "DESCRIPTION_TOO_LONG", index: 0 } });
    });

    it("accepts and trims a description at exactly the max length", () => {
      const description = `  ${"x".repeat(MAX_DESCRIPTION_LENGTH)}  `;
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "lineItems", lineItems: [{ description, quantity: "1", unitPrice: "1.00" }] },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.lineItems[0].description).toBe("x".repeat(MAX_DESCRIPTION_LENGTH));
    });
  });

  describe("quantity validation", () => {
    it("rejects zero quantity", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "lineItems", lineItems: [{ description: "a", quantity: "0", unitPrice: "1.00" }] },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result).toEqual({ ok: false, error: { code: "ZERO_OR_NEGATIVE_QUANTITY", index: 0 } });
    });

    it("rejects negative quantity", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "lineItems", lineItems: [{ description: "a", quantity: "-1", unitPrice: "1.00" }] },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result).toEqual({ ok: false, error: { code: "ZERO_OR_NEGATIVE_QUANTITY", index: 0 } });
    });

    it("rejects a quantity with more than 3 decimal places", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "lineItems", lineItems: [{ description: "a", quantity: "1.0001", unitPrice: "1.00" }] },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result).toEqual({ ok: false, error: { code: "QUANTITY_TOO_PRECISE", index: 0 } });
    });

    it("rejects a quantity above the Decimal(10,3) ceiling", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: {
          mode: "lineItems",
          lineItems: [{ description: "a", quantity: "10000000.000", unitPrice: "1.00" }],
        },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result).toEqual({ ok: false, error: { code: "QUANTITY_OUT_OF_RANGE", index: 0 } });
    });

    it("accepts the exact Decimal(10,3) maximum quantity", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: {
          mode: "lineItems",
          lineItems: [{ description: "a", quantity: "9999999.999", unitPrice: "1.00" }],
        },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result.ok).toBe(true);
    });
  });

  describe("unit price validation", () => {
    it("rejects a negative unit price", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "lineItems", lineItems: [{ description: "a", quantity: "1", unitPrice: "-0.01" }] },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result).toEqual({ ok: false, error: { code: "NEGATIVE_UNIT_PRICE", index: 0 } });
    });

    it("accepts a zero unit price (comped line)", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "lineItems", lineItems: [{ description: "a", quantity: "1", unitPrice: "0" }] },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.lineItems[0].lineTotal.toString()).toBe(dec("0.00"));
    });

    it("rejects a unit price with more than 2 decimal places", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "lineItems", lineItems: [{ description: "a", quantity: "1", unitPrice: "1.001" }] },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result).toEqual({ ok: false, error: { code: "UNIT_PRICE_TOO_PRECISE", index: 0 } });
    });

    it("rejects a unit price above the Decimal(10,2) ceiling", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "lineItems", lineItems: [{ description: "a", quantity: "1", unitPrice: "100000000.00" }] },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result).toEqual({ ok: false, error: { code: "UNIT_PRICE_OUT_OF_RANGE", index: 0 } });
    });
  });

  describe("per-line rounding before summation", () => {
    it("does NOT prove per-line rounding — an over-precise unitPrice (3 decimal places) is rejected before any calculation happens", () => {
      // This does not demonstrate independent per-line rounding: a
      // unitPrice of "1.005" has 3 decimal places, which unitPrice's own
      // <= 2-decimal-place validation rejects outright (UNIT_PRICE_TOO_PRECISE)
      // before quantity x unitPrice is ever computed for any line. The
      // actual proof of per-line ROUND_HALF_UP-before-summation is the
      // next test below, which uses a valid 2-decimal-place unitPrice
      // whose raw product still lands on a rounding boundary.
      const result = calculateInvoiceTotals({
        subtotalSource: {
          mode: "lineItems",
          lineItems: [
            { description: "a", quantity: "1", unitPrice: "1.005" },
            { description: "b", quantity: "1", unitPrice: "1.005" },
            { description: "c", quantity: "1", unitPrice: "1.005" },
          ],
        },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result).toEqual({ ok: false, error: { code: "UNIT_PRICE_TOO_PRECISE", index: 0 } });
    });

    it("proves per-line rounding: two lines with a .5-cent raw total each round independently: 3.335 -> 3.34 twice, not 6.67 as one sum", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: {
          mode: "lineItems",
          lineItems: [
            { description: "a", quantity: "6.67", unitPrice: "0.50" },
            { description: "b", quantity: "6.67", unitPrice: "0.50" },
          ],
        },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // 6.67 * 0.50 = 3.335 -> ROUND_HALF_UP -> 3.34, per line.
      expect(result.lineItems[0].lineTotal.toString()).toBe(dec("3.34"));
      expect(result.lineItems[1].lineTotal.toString()).toBe(dec("3.34"));
      expect(result.subtotal.toString()).toBe(dec("6.68"));
    });
  });

  describe("discount validation", () => {
    it("NONE discount produces zero discountAmount", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "100.00" },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.discountAmount.toString()).toBe(dec("0"));
    });

    it("rejects a PERCENTAGE discount below 0", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "100.00" },
        discount: { type: "PERCENTAGE", value: "-1" },
        taxRatePercent: null,
      });
      expect(result).toEqual({ ok: false, error: { code: "DISCOUNT_PERCENTAGE_OUT_OF_RANGE" } });
    });

    it("rejects a PERCENTAGE discount above 100", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "100.00" },
        discount: { type: "PERCENTAGE", value: "100.01" },
        taxRatePercent: null,
      });
      expect(result).toEqual({ ok: false, error: { code: "DISCOUNT_PERCENTAGE_OUT_OF_RANGE" } });
    });

    it("accepts PERCENTAGE discount boundaries 0 and 100", () => {
      const zero = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "100.00" },
        discount: { type: "PERCENTAGE", value: "0" },
        taxRatePercent: null,
      });
      expect(zero.ok).toBe(true);
      if (zero.ok) expect(zero.discountAmount.toString()).toBe(dec("0.00"));

      const hundred = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "100.00" },
        discount: { type: "PERCENTAGE", value: "100" },
        taxRatePercent: null,
      });
      expect(hundred.ok).toBe(true);
      if (hundred.ok) expect(hundred.total.toString()).toBe(dec("0.00"));
    });

    it("rejects a PERCENTAGE discount with more than 2 decimal places", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "100.00" },
        discount: { type: "PERCENTAGE", value: "10.123" },
        taxRatePercent: null,
      });
      expect(result).toEqual({ ok: false, error: { code: "DISCOUNT_PERCENTAGE_OUT_OF_RANGE" } });
    });

    it("rejects a negative FIXED discount", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "100.00" },
        discount: { type: "FIXED", value: "-5.00" },
        taxRatePercent: null,
      });
      expect(result).toEqual({ ok: false, error: { code: "DISCOUNT_VALUE_INVALID" } });
    });

    it("accepts a FIXED discount exactly equal to subtotal (legal zero total)", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "42.00" },
        discount: { type: "FIXED", value: "42.00" },
        taxRatePercent: null,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.total.toString()).toBe(dec("0.00"));
    });
  });

  describe("tax validation", () => {
    it("null tax rate produces zero taxAmount", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "100.00" },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.taxAmount.toString()).toBe(dec("0"));
    });

    it("rejects a tax rate below 0", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "100.00" },
        discount: { type: "NONE" },
        taxRatePercent: "-0.01",
      });
      expect(result).toEqual({ ok: false, error: { code: "TAX_RATE_OUT_OF_RANGE" } });
    });

    it("rejects a tax rate above 100", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "100.00" },
        discount: { type: "NONE" },
        taxRatePercent: "100.01",
      });
      expect(result).toEqual({ ok: false, error: { code: "TAX_RATE_OUT_OF_RANGE" } });
    });

    it("rejects a tax rate with more than 2 decimal places", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "100.00" },
        discount: { type: "NONE" },
        taxRatePercent: "8.255",
      });
      expect(result).toEqual({ ok: false, error: { code: "TAX_RATE_OUT_OF_RANGE" } });
    });

    it("accepts tax rate boundaries 0 and 100", () => {
      const zero = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "100.00" },
        discount: { type: "NONE" },
        taxRatePercent: "0",
      });
      expect(zero.ok).toBe(true);
      if (zero.ok) expect(zero.taxAmount.toString()).toBe(dec("0.00"));

      const hundred = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "100.00" },
        discount: { type: "NONE" },
        taxRatePercent: "100",
      });
      expect(hundred.ok).toBe(true);
      if (hundred.ok) expect(hundred.taxAmount.toString()).toBe(dec("100.00"));
    });

    it("tax is computed on subtotal minus discount, not on raw subtotal", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "100.00" },
        discount: { type: "PERCENTAGE", value: "50" },
        taxRatePercent: "10",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // subtotal 100, discount 50 -> taxable base 50, tax 10% = 5.00 (not 10.00).
      expect(result.discountAmount.toString()).toBe(dec("50.00"));
      expect(result.taxAmount.toString()).toBe(dec("5.00"));
      expect(result.total.toString()).toBe(dec("55.00"));
    });
  });

  describe("overflow boundaries", () => {
    it("accepts the exact Decimal(10,2) maximum flat amount", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "99999999.99" },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.total.toString()).toBe(dec("99999999.99"));
    });

    it("rejects a flat amount above the Decimal(10,2) ceiling", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "100000000.00" },
        discount: { type: "NONE" },
        taxRatePercent: null,
      });
      expect(result).toEqual({ ok: false, error: { code: "INVALID_FLAT_AMOUNT" } });
    });

    it("rejects a total that overflows after tax is added, even though subtotal alone did not", () => {
      const result = calculateInvoiceTotals({
        subtotalSource: { mode: "flat", amount: "99999999.99" },
        discount: { type: "NONE" },
        taxRatePercent: "1",
      });
      expect(result).toEqual({ ok: false, error: { code: "TOTAL_OUT_OF_RANGE" } });
    });
  });

  describe("no mutation of input", () => {
    it("does not mutate the input line-items array or its objects", () => {
      const lineItems: LineItemInput[] = [{ description: "  Design work  ", quantity: "1", unitPrice: "1.00" }];
      const snapshotBefore = JSON.parse(JSON.stringify(lineItems));

      const input = {
        subtotalSource: { mode: "lineItems" as const, lineItems },
        discount: { type: "NONE" as const },
        taxRatePercent: null,
      };
      const inputSnapshotBefore = JSON.parse(JSON.stringify(input));

      calculateInvoiceTotals(input);

      expect(lineItems).toEqual(snapshotBefore);
      expect(input).toEqual(inputSnapshotBefore);
    });
  });
});
