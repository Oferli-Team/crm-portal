import { describe, expect, it } from "vitest";
import {
  decodeInvoiceLineItemsFormValue,
  encodeInvoiceLineItemsFormValue,
  MAX_RAW_LINE_ITEMS_PAYLOAD_LENGTH,
  type InvoiceLineItemFormValue,
} from "@/lib/invoices/line-items-form";
import { MAX_LINE_ITEMS, MAX_DESCRIPTION_LENGTH } from "@/lib/invoices/calculations";

/** The old, now-corrected transport ceiling — used only to prove the new limit's regression fixture would have been wrongly rejected under it. */
const OLD_MAX_RAW_LINE_ITEMS_PAYLOAD_LENGTH = 131072;

function makeItems(count: number): InvoiceLineItemFormValue[] {
  return Array.from({ length: count }, (_, i) => ({
    description: `Item ${i}`,
    quantity: "1",
    unitPrice: "1.00",
  }));
}

/** Builds a raw JSON string (one line item, padded description) of exactly `targetLength` characters. */
function buildJsonOfExactLength(targetLength: number): string {
  const prefix = '[{"description":"';
  const suffix = '","quantity":"1","unitPrice":"1.00"}]';
  const padLength = targetLength - prefix.length - suffix.length;
  if (padLength < 0) {
    throw new Error(`targetLength ${targetLength} too small for this helper's own JSON overhead`);
  }
  return `${prefix}${"x".repeat(padLength)}${suffix}`;
}

describe("decodeInvoiceLineItemsFormValue", () => {
  it("valid encode/decode round trip", () => {
    const items = makeItems(3);
    const encoded = encodeInvoiceLineItemsFormValue(items);
    const result = decodeInvoiceLineItemsFormValue(encoded);
    expect(result).toEqual({ ok: true, lineItems: items });
  });

  it("an empty array decodes successfully — EMPTY_LINE_ITEMS is calculateInvoiceTotals()'s concern, not this decoder's", () => {
    const result = decodeInvoiceLineItemsFormValue("[]");
    expect(result).toEqual({ ok: true, lineItems: [] });
  });

  it(`accepts exactly MAX_LINE_ITEMS (${MAX_LINE_ITEMS}) items`, () => {
    const encoded = encodeInvoiceLineItemsFormValue(makeItems(MAX_LINE_ITEMS));
    const result = decodeInvoiceLineItemsFormValue(encoded);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.lineItems).toHaveLength(MAX_LINE_ITEMS);
  });

  it(`rejects MAX_LINE_ITEMS + 1 (${MAX_LINE_ITEMS + 1}) items with TOO_MANY_LINE_ITEMS`, () => {
    const encoded = encodeInvoiceLineItemsFormValue(makeItems(MAX_LINE_ITEMS + 1));
    const result = decodeInvoiceLineItemsFormValue(encoded);
    expect(result).toEqual({ ok: false, error: { code: "TOO_MANY_LINE_ITEMS" } });
  });

  describe("raw payload size boundary — checked before JSON.parse", () => {
    it("accepts a raw payload of exactly MAX_RAW_LINE_ITEMS_PAYLOAD_LENGTH characters (valid JSON)", () => {
      const raw = buildJsonOfExactLength(MAX_RAW_LINE_ITEMS_PAYLOAD_LENGTH);
      expect(raw.length).toBe(MAX_RAW_LINE_ITEMS_PAYLOAD_LENGTH);
      const result = decodeInvoiceLineItemsFormValue(raw);
      expect(result.ok).toBe(true);
    });

    it("rejects a raw payload one character above the boundary with PAYLOAD_TOO_LARGE, proven to happen BEFORE any parse attempt (the oversized content here is not even valid JSON)", () => {
      const raw = "x".repeat(MAX_RAW_LINE_ITEMS_PAYLOAD_LENGTH + 1);
      const result = decodeInvoiceLineItemsFormValue(raw);
      // If the length check ran after (or was skipped), this invalid-JSON
      // content would produce MALFORMED_JSON instead — PAYLOAD_TOO_LARGE
      // here is direct proof of the required ordering.
      expect(result).toEqual({ ok: false, error: { code: "PAYLOAD_TOO_LARGE" } });
    });
  });

  describe("worst-case JSON-escaping regression — a semantically valid fixture must not be rejected on size", () => {
    it(`accepts MAX_LINE_ITEMS entries whose descriptions are exactly MAX_DESCRIPTION_LENGTH characters, each escaped at JSON's maximum 6-code-unit rate (\\u0000)`, () => {
      const items = Array.from({ length: MAX_LINE_ITEMS }, () => ({
        description: "\u0000".repeat(MAX_DESCRIPTION_LENGTH),
        quantity: "1",
        unitPrice: "1.00",
      }));
      const encoded = encodeInvoiceLineItemsFormValue(items);

      // This is exactly the fixture the old 131072 limit would have wrongly
      // rejected, even though every field is within calculateInvoiceTotals()'s
      // own semantic bounds (MAX_LINE_ITEMS items, MAX_DESCRIPTION_LENGTH
      // descriptions) — proving the old limit was too tight.
      expect(encoded.length).toBeGreaterThan(OLD_MAX_RAW_LINE_ITEMS_PAYLOAD_LENGTH);
      // The corrected limit must still comfortably admit it.
      expect(encoded.length).toBeLessThanOrEqual(MAX_RAW_LINE_ITEMS_PAYLOAD_LENGTH);

      const result = decodeInvoiceLineItemsFormValue(encoded);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.lineItems).toHaveLength(MAX_LINE_ITEMS);
        for (const item of result.lineItems) {
          expect(item.description).toHaveLength(MAX_DESCRIPTION_LENGTH);
        }
      }
      // Deliberately not passed to calculateInvoiceTotals() — this test is
      // transport/shape testing only, per this decoder's own documented scope.
    });
  });

  it("catches malformed JSON as a controlled result, never throws", () => {
    expect(() => decodeInvoiceLineItemsFormValue("{not valid json")).not.toThrow();
    const result = decodeInvoiceLineItemsFormValue("{not valid json");
    expect(result).toEqual({ ok: false, error: { code: "MALFORMED_JSON" } });
  });

  it("never returns a raw JSON.parse error message or the submitted payload contents", () => {
    const result = decodeInvoiceLineItemsFormValue("not json at all, definitely malformed");
    expect(result).toEqual({ ok: false, error: { code: "MALFORMED_JSON" } });
    expect(JSON.stringify(result)).not.toContain("not json at all");
  });

  describe("top-level value must be an array", () => {
    for (const [label, raw] of [
      ["null", "null"],
      ["a plain object", '{"description":"x","quantity":"1","unitPrice":"1"}'],
      ["a string", '"just a string"'],
      ["a number", "42"],
    ] as const) {
      it(`rejects ${label} with NOT_ARRAY`, () => {
        expect(decodeInvoiceLineItemsFormValue(raw)).toEqual({ ok: false, error: { code: "NOT_ARRAY" } });
      });
    }
  });

  describe("every entry must be a non-null, non-array object", () => {
    for (const [label, raw] of [
      ["null", "[null]"],
      ["an array", "[[]]"],
      ["a string", '["oops"]'],
      ["a number", "[42]"],
    ] as const) {
      it(`rejects an entry that is ${label}, with the failing index`, () => {
        expect(decodeInvoiceLineItemsFormValue(raw)).toEqual({
          ok: false,
          error: { code: "INVALID_ITEM_SHAPE", index: 0 },
        });
      });
    }
  });

  describe("every entry's description/quantity/unitPrice must be a string", () => {
    it("rejects a non-string description", () => {
      const raw = JSON.stringify([{ description: 123, quantity: "1", unitPrice: "1.00" }]);
      expect(decodeInvoiceLineItemsFormValue(raw)).toEqual({
        ok: false,
        error: { code: "INVALID_ITEM_SHAPE", index: 0 },
      });
    });

    it("rejects a non-string quantity", () => {
      const raw = JSON.stringify([{ description: "x", quantity: 1, unitPrice: "1.00" }]);
      expect(decodeInvoiceLineItemsFormValue(raw)).toEqual({
        ok: false,
        error: { code: "INVALID_ITEM_SHAPE", index: 0 },
      });
    });

    it("rejects a non-string unitPrice", () => {
      const raw = JSON.stringify([{ description: "x", quantity: "1", unitPrice: 1.0 }]);
      expect(decodeInvoiceLineItemsFormValue(raw)).toEqual({
        ok: false,
        error: { code: "INVALID_ITEM_SHAPE", index: 0 },
      });
    });

    it("returns the failing item's own index, not always 0, for a later entry", () => {
      const raw = JSON.stringify([
        { description: "ok 1", quantity: "1", unitPrice: "1.00" },
        { description: "ok 2", quantity: "2", unitPrice: "2.00" },
        { description: "bad", quantity: 3, unitPrice: "3.00" },
      ]);
      expect(decodeInvoiceLineItemsFormValue(raw)).toEqual({
        ok: false,
        error: { code: "INVALID_ITEM_SHAPE", index: 2 },
      });
    });
  });

  it("discards extra submitted properties (id/position/lineTotal/invoiceId/organizationId/clientId/total) rather than trusting them", () => {
    const raw = JSON.stringify([
      {
        id: "tampered-id",
        position: 999,
        lineTotal: "999999.99",
        invoiceId: "someone-elses-invoice",
        organizationId: "someone-elses-org",
        clientId: "someone-elses-client",
        total: "999999.99",
        description: "Real description",
        quantity: "2",
        unitPrice: "10.00",
      },
    ]);
    const result = decodeInvoiceLineItemsFormValue(raw);
    expect(result).toEqual({
      ok: true,
      lineItems: [{ description: "Real description", quantity: "2", unitPrice: "10.00" }],
    });
    if (result.ok) {
      const keys = Object.keys(result.lineItems[0]);
      expect(keys.sort()).toEqual(["description", "quantity", "unitPrice"]);
    }
  });
});

describe("encodeInvoiceLineItemsFormValue", () => {
  it("allowlists only description/quantity/unitPrice, even if the caller's object has additional properties", () => {
    const itemWithExtra = {
      description: "x",
      quantity: "1",
      unitPrice: "1.00",
      id: "should-not-appear",
      position: 0,
    } as InvoiceLineItemFormValue & { id: string; position: number };

    const encoded = encodeInvoiceLineItemsFormValue([itemWithExtra]);
    const parsed = JSON.parse(encoded);
    expect(parsed).toEqual([{ description: "x", quantity: "1", unitPrice: "1.00" }]);
    expect(Object.keys(parsed[0]).sort()).toEqual(["description", "quantity", "unitPrice"]);
  });

  it("round-trips an empty array", () => {
    expect(decodeInvoiceLineItemsFormValue(encodeInvoiceLineItemsFormValue([]))).toEqual({
      ok: true,
      lineItems: [],
    });
  });

  it("does not mutate its input array", () => {
    const items = makeItems(2);
    const snapshot = JSON.parse(JSON.stringify(items));
    encodeInvoiceLineItemsFormValue(items);
    expect(items).toEqual(snapshot);
  });
});
