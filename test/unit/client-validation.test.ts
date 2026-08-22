import { describe, expect, it } from "vitest";
import { parseClientForm, CLIENT_BILLING_MAX_LENGTHS } from "@/lib/validation/client";

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("parseClientForm — billing identity fields (Invoice System Slice 1, docs/invoicing-architecture.md §4.4)", () => {
  it("an empty submission leaves every billing field null, with no field errors", () => {
    const { values, fieldErrors } = parseClientForm(formData({ name: "Acme" }));
    expect(fieldErrors).toEqual({});
    expect(values.billingLegalName).toBeNull();
    expect(values.taxId).toBeNull();
    expect(values.streetAddress).toBeNull();
    expect(values.city).toBeNull();
    expect(values.state).toBeNull();
    expect(values.postalCode).toBeNull();
    expect(values.country).toBeNull();
  });

  it("whitespace-only input normalizes to null for every billing field", () => {
    const { values, fieldErrors } = parseClientForm(
      formData({
        name: "Acme",
        billingLegalName: "   ",
        taxId: "  ",
        streetAddress: "   ",
        city: "  ",
        state: "   ",
        postalCode: "  ",
        country: "   ",
      }),
    );
    expect(fieldErrors).toEqual({});
    expect(values.billingLegalName).toBeNull();
    expect(values.taxId).toBeNull();
    expect(values.streetAddress).toBeNull();
    expect(values.city).toBeNull();
    expect(values.state).toBeNull();
    expect(values.postalCode).toBeNull();
    expect(values.country).toBeNull();
  });

  it("accepts a fully valid submission of every billing field, trimmed", () => {
    const { values, fieldErrors } = parseClientForm(
      formData({
        name: "Acme",
        billingLegalName: "  Acme Corporation, LLC  ",
        taxId: "  EU123456789  ",
        streetAddress: "  123 Main St  ",
        city: "  Springfield  ",
        state: "  IL  ",
        postalCode: "  62704  ",
        country: "  United States  ",
      }),
    );
    expect(fieldErrors).toEqual({});
    expect(values.billingLegalName).toBe("Acme Corporation, LLC");
    expect(values.taxId).toBe("EU123456789");
    expect(values.streetAddress).toBe("123 Main St");
    expect(values.city).toBe("Springfield");
    expect(values.state).toBe("IL");
    expect(values.postalCode).toBe("62704");
    expect(values.country).toBe("United States");
  });

  describe("max-length boundaries", () => {
    const fieldsAndLimits = Object.entries(CLIENT_BILLING_MAX_LENGTHS) as [keyof typeof CLIENT_BILLING_MAX_LENGTHS, number][];

    for (const [field, limit] of fieldsAndLimits) {
      it(`${field}: accepts exactly ${limit} characters`, () => {
        const { fieldErrors } = parseClientForm(formData({ name: "Acme", [field]: "x".repeat(limit) }));
        expect(fieldErrors[field]).toBeUndefined();
      });

      it(`${field}: rejects ${limit + 1} characters`, () => {
        const { fieldErrors } = parseClientForm(formData({ name: "Acme", [field]: "x".repeat(limit + 1) }));
        expect(fieldErrors[field]).toBeDefined();
      });
    }
  });

  it("an over-limit billing field does not block the rest of the submission from parsing", () => {
    const { values, fieldErrors } = parseClientForm(
      formData({ name: "Acme", taxId: "x".repeat(CLIENT_BILLING_MAX_LENGTHS.taxId + 1), city: "Springfield" }),
    );
    expect(fieldErrors.taxId).toBeDefined();
    expect(values.city).toBe("Springfield");
  });
});
