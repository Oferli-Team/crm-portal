import { MAX_LINE_ITEMS } from "@/lib/invoices/calculations";

/**
 * Invoice System Slice 2a — pure encode/decode for the single hidden JSON
 * `FormData` field the future itemized line-item editor will submit
 * (docs/invoicing-architecture.md §14 Slice 2). Not wired into any live
 * route, Server Action, or component yet — Slice 2b does that.
 *
 * This module performs TRANSPORT/SHAPE validation only — is the submitted
 * payload well-formed JSON, is it an array, is it within a sane size/count
 * bound, does every entry have the three allowlisted string fields. It
 * makes no claim about whether a `quantity`/`unitPrice` string is a valid,
 * in-range, correctly-precise decimal — that semantic financial validation
 * remains exclusively `calculateInvoiceTotals()`'s job (Slice 2b calls
 * both: this module first, to get a shaped array, then
 * `calculateInvoiceTotals()` on the result).
 */

export type InvoiceLineItemFormValue = {
  description: string;
  quantity: string;
  unitPrice: string;
};

/**
 * A conservative, bounded ceiling on the raw JSON string's length, checked
 * BEFORE `JSON.parse` is ever called — so an arbitrarily large adversarial
 * payload is never parsed merely to discover it exceeds `MAX_LINE_ITEMS`.
 *
 * Measured in JavaScript string `.length` (UTF-16 code units), not bytes.
 * This matters because `JSON.stringify`/`JSON.parse` can expand a single
 * source character into up to six UTF-16 code units of encoded JSON text
 * (a `\uXXXX` escape — e.g. a NUL or lone-surrogate-style character), and
 * `calculateInvoiceTotals()` neither forbids such characters in a
 * description nor treats them as invalid — only `MAX_DESCRIPTION_LENGTH`
 * (a count of *decoded* characters) bounds description length. A transport
 * limit sized only for "ordinary" characters would therefore reject a
 * payload that is still entirely valid under that semantic contract.
 *
 * 786432 (768 KiB) UTF-16 code units is sized for the worst case, not the
 * typical one: `MAX_LINE_ITEMS` entries, each with a description of
 * exactly `MAX_DESCRIPTION_LENGTH` characters where every character is
 * escaped at the maximum six-code-unit rate, plus ordinary
 * quantity/unitPrice strings and JSON structural overhead (field names,
 * quotes, commas, braces, the enclosing array brackets). This comfortably
 * exceeds that worst-case size while still rejecting a payload orders of
 * magnitude larger than anything a real itemized invoice could ever need.
 *
 * This bound is a pre-parse SHAPE/SIZE limit only — whether a given
 * description, quantity, or unitPrice is itself semantically valid
 * (length, numeric format, range) remains exclusively
 * `calculateInvoiceTotals()`'s responsibility.
 */
export const MAX_RAW_LINE_ITEMS_PAYLOAD_LENGTH = 786432;

export type DecodeLineItemsError =
  | { code: "PAYLOAD_TOO_LARGE" }
  | { code: "MALFORMED_JSON" }
  | { code: "NOT_ARRAY" }
  | { code: "TOO_MANY_LINE_ITEMS" }
  | { code: "INVALID_ITEM_SHAPE"; index: number };

export type DecodeLineItemsResult =
  | { ok: true; lineItems: InvoiceLineItemFormValue[] }
  | { ok: false; error: DecodeLineItemsError };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decodes and shape-validates the raw hidden-field string, in this exact
 * order: (1) reject an oversized raw string before ever parsing it; (2)
 * parse, catching a malformed-JSON failure as a controlled result, never a
 * thrown exception; (3) reject a non-array; (4) reject too many items,
 * using the same `MAX_LINE_ITEMS` ceiling `calculateInvoiceTotals()` itself
 * enforces (imported, never redefined as a second literal `200`); (5)
 * validate every entry is a non-null, non-array object whose
 * `description`/`quantity`/`unitPrice` are all strings.
 *
 * The returned line items contain ONLY these three allowlisted
 * properties — any other submitted key on an entry (`id`, `position`,
 * `lineTotal`, `invoiceId`, `organizationId`, `clientId`, `total`, or
 * anything else) is silently discarded, never copied into the output,
 * never trusted. An empty array decodes successfully (`ok: true,
 * lineItems: []`); rejecting an empty itemized submission is
 * `calculateInvoiceTotals()`'s `EMPTY_LINE_ITEMS` concern, not this
 * decoder's.
 *
 * Never throws for malformed user input, and never returns a raw
 * `JSON.parse` error message or the submitted payload contents — only a
 * fixed, stable error code (plus a failing index where applicable).
 */
export function decodeInvoiceLineItemsFormValue(raw: string): DecodeLineItemsResult {
  if (raw.length > MAX_RAW_LINE_ITEMS_PAYLOAD_LENGTH) {
    return { ok: false, error: { code: "PAYLOAD_TOO_LARGE" } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: { code: "MALFORMED_JSON" } };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, error: { code: "NOT_ARRAY" } };
  }

  if (parsed.length > MAX_LINE_ITEMS) {
    return { ok: false, error: { code: "TOO_MANY_LINE_ITEMS" } };
  }

  const lineItems: InvoiceLineItemFormValue[] = [];
  for (let index = 0; index < parsed.length; index++) {
    const entry: unknown = parsed[index];
    if (
      !isPlainObject(entry) ||
      typeof entry.description !== "string" ||
      typeof entry.quantity !== "string" ||
      typeof entry.unitPrice !== "string"
    ) {
      return { ok: false, error: { code: "INVALID_ITEM_SHAPE", index } };
    }

    // Only these three properties are ever read from `entry` — any other
    // submitted key (id/position/lineTotal/invoiceId/organizationId/
    // clientId/total/...) is never referenced, never copied.
    lineItems.push({
      description: entry.description,
      quantity: entry.quantity,
      unitPrice: entry.unitPrice,
    });
  }

  return { ok: true, lineItems };
}

/**
 * Serializes a line-item array into the same hidden-field string shape
 * `decodeInvoiceLineItemsFormValue` reads. Allowlists exactly `description`/
 * `quantity`/`unitPrice` on each entry — even if the caller holds (or
 * passes, via a wider-typed reference) an object with additional
 * properties, only these three are ever read and written into the output.
 */
export function encodeInvoiceLineItemsFormValue(items: readonly InvoiceLineItemFormValue[]): string {
  return JSON.stringify(
    items.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    })),
  );
}
