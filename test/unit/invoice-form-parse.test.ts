import { describe, expect, it } from "vitest";
import { parseInvoiceForm, hasInvoiceFormErrors, INVOICE_NOTES_MAX_LENGTH } from "@/lib/validation/invoice";
import { encodeInvoiceLineItemsFormValue } from "@/lib/invoices/line-items-form";

/** Constructs a valid flat submission's FormData with the "mode" key entirely absent — never even set to "". */
function flatFormDataWithoutModeKey(): FormData {
  const fd = new FormData();
  fd.set("invoiceNumber", "INV-1");
  fd.set("projectId", "11111111-1111-4111-8111-111111111111");
  fd.set("amount", "100.00");
  fd.set("currency", "USD");
  fd.set("issueDate", "2026-08-16");
  fd.set("dueDate", "");
  fd.set("notes", "");
  fd.set("internalNotes", "");
  fd.set("discountType", "NONE");
  fd.set("discountValue", "");
  fd.set("taxRatePercent", "");
  fd.set("taxLabel", "TAX");
  return fd;
}

function baseFlatFormData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  const fields: Record<string, string> = {
    mode: "flat",
    invoiceNumber: "INV-1",
    projectId: "11111111-1111-4111-8111-111111111111",
    amount: "100.00",
    currency: "USD",
    issueDate: "2026-08-16",
    dueDate: "",
    notes: "",
    internalNotes: "",
    discountType: "NONE",
    discountValue: "",
    taxRatePercent: "",
    taxLabel: "TAX",
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("parseInvoiceForm — flat mode", () => {
  it("parses a valid flat submission", () => {
    const result = parseInvoiceForm(baseFlatFormData());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values.mode).toBe("flat");
      expect(result.values.amount).toBe("100.00");
      expect(result.values.lineItems).toBeNull();
      expect(result.values.issueDate).toBeInstanceOf(Date);
      expect(result.values.dueDate).toBeNull();
    }
  });

  it("requires invoiceNumber", () => {
    const result = parseInvoiceForm(baseFlatFormData({ invoiceNumber: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.invoiceNumber).toBeTruthy();
  });

  it("requires projectId", () => {
    const result = parseInvoiceForm(baseFlatFormData({ projectId: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.projectId).toBeTruthy();
  });

  it("requires amount in flat mode", () => {
    const result = parseInvoiceForm(baseFlatFormData({ amount: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.amount).toBeTruthy();
  });

  it("ignores an irrelevant submitted lineItems field in flat mode", () => {
    const result = parseInvoiceForm(baseFlatFormData({ lineItems: "not even valid json" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.lineItems).toBeNull();
  });

  it("uppercase-normalizes and validates currency", () => {
    const result = parseInvoiceForm(baseFlatFormData({ currency: "usd" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.currency).toBe("USD");
  });

  it("rejects an unsupported currency", () => {
    const result = parseInvoiceForm(baseFlatFormData({ currency: "JPY" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.currency).toBeTruthy();
  });

  it("rejects a missing/invalid issueDate", () => {
    const result = parseInvoiceForm(baseFlatFormData({ issueDate: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.issueDate).toBeTruthy();

    const result2 = parseInvoiceForm(baseFlatFormData({ issueDate: "2026-02-30" }));
    expect(result2.ok).toBe(false);
    if (!result2.ok) expect(result2.fieldErrors.issueDate).toBeTruthy();
  });

  it("empty dueDate parses to null; invalid dueDate is an error", () => {
    const result = parseInvoiceForm(baseFlatFormData({ dueDate: "" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.dueDate).toBeNull();

    const result2 = parseInvoiceForm(baseFlatFormData({ dueDate: "not-a-date" }));
    expect(result2.ok).toBe(false);
    if (!result2.ok) expect(result2.fieldErrors.dueDate).toBeTruthy();
  });

  it("trims notes/internalNotes and normalizes empty to null", () => {
    const result = parseInvoiceForm(baseFlatFormData({ notes: "  hello  ", internalNotes: "" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values.notes).toBe("hello");
      expect(result.values.internalNotes).toBeNull();
    }
  });

  it("rejects notes/internalNotes over the max length", () => {
    const tooLong = "x".repeat(INVOICE_NOTES_MAX_LENGTH + 1);
    const result = parseInvoiceForm(baseFlatFormData({ notes: tooLong }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.notes).toBeTruthy();

    const result2 = parseInvoiceForm(baseFlatFormData({ internalNotes: tooLong }));
    expect(result2.ok).toBe(false);
    if (!result2.ok) expect(result2.fieldErrors.internalNotes).toBeTruthy();
  });

  it("accepts exactly the max length for notes", () => {
    const exact = "x".repeat(INVOICE_NOTES_MAX_LENGTH);
    const result = parseInvoiceForm(baseFlatFormData({ notes: exact }));
    expect(result.ok).toBe(true);
  });

  it("requires discountValue when discountType is not NONE", () => {
    const result = parseInvoiceForm(baseFlatFormData({ discountType: "PERCENTAGE", discountValue: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.discountValue).toBeTruthy();
  });

  it("discountValue is null when discountType is NONE, even if submitted", () => {
    const result = parseInvoiceForm(baseFlatFormData({ discountType: "NONE", discountValue: "50" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.discountValue).toBeNull();
  });

  it("empty taxRatePercent parses to null", () => {
    const result = parseInvoiceForm(baseFlatFormData({ taxRatePercent: "" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.taxRatePercent).toBeNull();
  });

  it("rejects an invalid discountType/taxLabel by falling back and reporting a field error", () => {
    const result = parseInvoiceForm(baseFlatFormData({ discountType: "BOGUS" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.discountType).toBeTruthy();

    const result2 = parseInvoiceForm(baseFlatFormData({ taxLabel: "BOGUS" }));
    expect(result2.ok).toBe(false);
    if (!result2.ok) expect(result2.fieldErrors.taxLabel).toBeTruthy();
  });

  it("never reads a status field from formData, even if submitted", () => {
    const fd = baseFlatFormData();
    fd.set("status", "PAID");
    const result = parseInvoiceForm(fd);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values).not.toHaveProperty("status");
  });
});

describe("parseInvoiceForm — itemized mode", () => {
  it("parses valid line items and ignores the irrelevant flat amount field", () => {
    const lineItems = [{ description: "Design", quantity: "2", unitPrice: "50.00" }];
    const fd = baseFlatFormData({ mode: "itemized", amount: "999.99", lineItems: encodeInvoiceLineItemsFormValue(lineItems) });
    const result = parseInvoiceForm(fd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values.amount).toBeNull();
      expect(result.values.lineItems).toEqual(lineItems);
    }
  });

  it("an empty itemized array parses successfully (EMPTY_LINE_ITEMS is calculateInvoiceTotals()'s concern)", () => {
    const fd = baseFlatFormData({ mode: "itemized", lineItems: encodeInvoiceLineItemsFormValue([]) });
    const result = parseInvoiceForm(fd);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.lineItems).toEqual([]);
  });

  it("maps a malformed lineItems payload to fieldErrors.lineItems", () => {
    const fd = baseFlatFormData({ mode: "itemized", lineItems: "{not valid json" });
    const result = parseInvoiceForm(fd);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.lineItems).toBeTruthy();
  });

  it("maps an invalid item shape to a lineItemErrors entry at the failing index", () => {
    const fd = baseFlatFormData({ mode: "itemized", lineItems: JSON.stringify([{ description: "ok", quantity: "1", unitPrice: "1" }, { description: "bad", quantity: 5, unitPrice: "1" }]) });
    const result = parseInvoiceForm(fd);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.lineItemErrors?.[1]).toBeTruthy();
      expect(result.lineItemErrors?.[0]).toBeUndefined();
    }
  });
});

describe("parseInvoiceForm — strict mode validation", () => {
  it("accepts exactly 'flat'", () => {
    const result = parseInvoiceForm(baseFlatFormData({ mode: "flat" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.mode).toBe("flat");
  });

  it("accepts exactly 'itemized'", () => {
    const lineItems = encodeInvoiceLineItemsFormValue([{ description: "A", quantity: "1", unitPrice: "1.00" }]);
    const result = parseInvoiceForm(baseFlatFormData({ mode: "itemized", lineItems }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.mode).toBe("itemized");
  });

  it("rejects a missing mode field (never even submitted) with fieldErrors.mode, never reaching an ok:true result", () => {
    const result = parseInvoiceForm(flatFormDataWithoutModeKey());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.mode).toBeTruthy();
  });

  it("rejects an empty mode value", () => {
    const result = parseInvoiceForm(baseFlatFormData({ mode: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.mode).toBeTruthy();
  });

  it.each(["FLAT", "Itemized", "bogus"])("rejects a forged/mis-cased value: %s", (value) => {
    const result = parseInvoiceForm(baseFlatFormData({ mode: value }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.mode).toBeTruthy();
  });

  it("an invalid mode still produces a well-formed rejected result — no crash, no ok:true", () => {
    const result = parseInvoiceForm(baseFlatFormData({ mode: "bogus" }));
    expect(result).toEqual(
      expect.objectContaining({ ok: false, fieldErrors: expect.objectContaining({ mode: expect.any(String) }) }),
    );
  });
});

describe("hasInvoiceFormErrors", () => {
  it("false when both collections are empty/undefined", () => {
    expect(hasInvoiceFormErrors(undefined, undefined)).toBe(false);
    expect(hasInvoiceFormErrors({}, {})).toBe(false);
  });

  it("true when only lineItemErrors has entries — the defect this gate fixes", () => {
    expect(hasInvoiceFormErrors({}, { 0: { description: "bad" } })).toBe(true);
  });

  it("true when only fieldErrors has entries", () => {
    expect(hasInvoiceFormErrors({ amount: "bad" }, undefined)).toBe(true);
  });
});
