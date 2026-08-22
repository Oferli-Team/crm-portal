import { describe, expect, it } from "vitest";
import { parseCompanyProfileForm, getSupportedCurrencies, getSupportedTimezones } from "@/lib/validation/company-profile";
import { parsePaymentDetailsForm } from "@/lib/validation/payment-details";
import { parseDomainSettingsForm } from "@/lib/validation/domain-settings";

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("parseCompanyProfileForm", () => {
  it("accepts a fully valid submission with no field errors", () => {
    const { values, fieldErrors } = parseCompanyProfileForm(
      formData({ legalName: "Acme Inc. LLC", displayName: "Acme", country: "United States", currency: "usd", timezone: "America/New_York" }),
    );
    expect(fieldErrors).toEqual({});
    expect(values).toEqual({
      legalName: "Acme Inc. LLC",
      displayName: "Acme",
      country: "United States",
      currency: "USD",
      timezone: "America/New_York",
      // Sale-Ready Phase A.1 (Business Identity), PR2 — all nine optional
      // fields are absent from this submission, so every one parses to
      // null, never an empty string and never a field error (they're
      // nullable, not required).
      supportEmail: null,
      website: null,
      phone: null,
      taxId: null,
      brandColor: null,
      streetAddress: null,
      city: null,
      state: null,
      postalCode: null,
    });
  });

  describe("Business Identity fields (Sale-Ready Phase A.1, PR2) — all optional", () => {
    const baseFields = { legalName: "A", displayName: "A", country: "A", currency: "USD", timezone: "America/New_York" };

    it("an empty submission leaves every optional field null, with no field errors", () => {
      const { values, fieldErrors } = parseCompanyProfileForm(formData(baseFields));
      expect(fieldErrors).toEqual({});
      expect(values.supportEmail).toBeNull();
      expect(values.website).toBeNull();
      expect(values.phone).toBeNull();
      expect(values.taxId).toBeNull();
      expect(values.brandColor).toBeNull();
      expect(values.streetAddress).toBeNull();
      expect(values.city).toBeNull();
      expect(values.state).toBeNull();
      expect(values.postalCode).toBeNull();
    });

    it("whitespace-only input normalizes to null, same as a fully empty field", () => {
      const { values, fieldErrors } = parseCompanyProfileForm(formData({ ...baseFields, phone: "   ", website: "  " }));
      expect(values.phone).toBeNull();
      expect(values.website).toBeNull();
      expect(fieldErrors.website).toBeUndefined();
    });

    it("accepts a fully valid submission of every optional field, trimmed", () => {
      const { values, fieldErrors } = parseCompanyProfileForm(
        formData({
          ...baseFields,
          supportEmail: "  support@acme.com  ",
          website: "https://acme.com",
          phone: "+1 555-0100",
          taxId: "EU123456789",
          brandColor: "#0F172A",
          streetAddress: "123 Main St",
          city: "Springfield",
          state: "IL",
          postalCode: "62704",
        }),
      );
      expect(fieldErrors).toEqual({});
      expect(values.supportEmail).toBe("support@acme.com");
      expect(values.website).toBe("https://acme.com");
      expect(values.phone).toBe("+1 555-0100");
      expect(values.taxId).toBe("EU123456789");
      expect(values.brandColor).toBe("#0F172A");
      expect(values.streetAddress).toBe("123 Main St");
      expect(values.city).toBe("Springfield");
      expect(values.state).toBe("IL");
      expect(values.postalCode).toBe("62704");
    });

    it("rejects a malformed supportEmail, using the same pattern every other email field already uses", () => {
      const { fieldErrors } = parseCompanyProfileForm(formData({ ...baseFields, supportEmail: "not-an-email" }));
      expect(fieldErrors.supportEmail).toBeTruthy();
    });

    it("rejects a website that isn't https", () => {
      const http = parseCompanyProfileForm(formData({ ...baseFields, website: "http://acme.com" }));
      expect(http.fieldErrors.website).toBeTruthy();

      const malformed = parseCompanyProfileForm(formData({ ...baseFields, website: "not a url" }));
      expect(malformed.fieldErrors.website).toBeTruthy();
    });

    it("rejects a brandColor that isn't #RRGGBB, accepts lowercase or uppercase hex", () => {
      const invalid = parseCompanyProfileForm(formData({ ...baseFields, brandColor: "blue" }));
      expect(invalid.fieldErrors.brandColor).toBeTruthy();

      const shortHex = parseCompanyProfileForm(formData({ ...baseFields, brandColor: "#fff" }));
      expect(shortHex.fieldErrors.brandColor).toBeTruthy();

      const upper = parseCompanyProfileForm(formData({ ...baseFields, brandColor: "#0F172A" }));
      expect(upper.fieldErrors.brandColor).toBeUndefined();

      const lower = parseCompanyProfileForm(formData({ ...baseFields, brandColor: "#0f172a" }));
      expect(lower.fieldErrors.brandColor).toBeUndefined();
    });

    it("phone/taxId/address fields accept any non-empty free-form text, no format validation", () => {
      const { fieldErrors } = parseCompanyProfileForm(
        formData({ ...baseFields, phone: "not a real phone format at all", taxId: "###", city: "123", state: "@@", postalCode: "abc" }),
      );
      expect(fieldErrors.phone).toBeUndefined();
      expect(fieldErrors.taxId).toBeUndefined();
      expect(fieldErrors.city).toBeUndefined();
      expect(fieldErrors.state).toBeUndefined();
      expect(fieldErrors.postalCode).toBeUndefined();
    });
  });

  it("requires every field", () => {
    const { fieldErrors } = parseCompanyProfileForm(formData({}));
    expect(fieldErrors.legalName).toBeTruthy();
    expect(fieldErrors.displayName).toBeTruthy();
    expect(fieldErrors.country).toBeTruthy();
    expect(fieldErrors.currency).toBeTruthy();
    expect(fieldErrors.timezone).toBeTruthy();
  });

  it("rejects a currency code Intl doesn't recognize, case-insensitively normalizing valid ones", () => {
    const invalid = parseCompanyProfileForm(
      formData({ legalName: "A", displayName: "A", country: "A", currency: "NOTREAL", timezone: "America/New_York" }),
    );
    expect(invalid.fieldErrors.currency).toBeTruthy();

    const valid = parseCompanyProfileForm(
      formData({ legalName: "A", displayName: "A", country: "A", currency: "eur", timezone: "America/New_York" }),
    );
    expect(valid.fieldErrors.currency).toBeUndefined();
    expect(valid.values.currency).toBe("EUR");
  });

  it("rejects a time zone Intl doesn't recognize", () => {
    const { fieldErrors } = parseCompanyProfileForm(
      formData({ legalName: "A", displayName: "A", country: "A", currency: "USD", timezone: "Not/A_Real_Zone" }),
    );
    expect(fieldErrors.timezone).toBeTruthy();
  });

  it("getSupportedCurrencies/getSupportedTimezones return real, non-empty, sorted catalogs", () => {
    const currencies = getSupportedCurrencies();
    const timezones = getSupportedTimezones();
    expect(currencies.length).toBeGreaterThan(50);
    expect(currencies).toContain("USD");
    expect(currencies).toEqual([...currencies].sort());
    expect(timezones.length).toBeGreaterThan(50);
    expect(timezones).toContain("America/New_York");
    expect(timezones).toEqual([...timezones].sort());
  });
});

describe("parsePaymentDetailsForm", () => {
  it("accepts a fully valid submission, with optional paymentInstructions", () => {
    const { values, fieldErrors } = parsePaymentDetailsForm(
      formData({ bankName: "First Bank", accountHolder: "Acme Inc.", accountNumber: "GB29NWBK60161331926819", swiftBic: "NWBKGB2L" }),
    );
    expect(fieldErrors).toEqual({});
    expect(values.paymentInstructions).toBeNull();
  });

  it("requires bankName/accountHolder/accountNumber/swiftBic, but not paymentInstructions", () => {
    const { fieldErrors } = parsePaymentDetailsForm(formData({}));
    expect(fieldErrors.bankName).toBeTruthy();
    expect(fieldErrors.accountHolder).toBeTruthy();
    expect(fieldErrors.accountNumber).toBeTruthy();
    expect(fieldErrors.swiftBic).toBeTruthy();
    expect(fieldErrors.paymentInstructions).toBeUndefined();
  });

  it("preserves a provided paymentInstructions value", () => {
    const { values } = parsePaymentDetailsForm(
      formData({
        bankName: "First Bank",
        accountHolder: "Acme Inc.",
        accountNumber: "123456",
        swiftBic: "NWBKGB2L",
        paymentInstructions: "Reference invoice number in the memo.",
      }),
    );
    expect(values.paymentInstructions).toBe("Reference invoice number in the memo.");
  });
});

describe("parseDomainSettingsForm", () => {
  it("an empty customDomain is valid (means: use the generated subdomain only)", () => {
    const { values, fieldErrors } = parseDomainSettingsForm(formData({}));
    expect(fieldErrors.customDomain).toBeUndefined();
    expect(values.customDomain).toBeNull();
  });

  it("accepts a well-formed domain, lowercased", () => {
    const { values, fieldErrors } = parseDomainSettingsForm(formData({ customDomain: "Custom-Domain.COM" }));
    expect(fieldErrors.customDomain).toBeUndefined();
    expect(values.customDomain).toBe("custom-domain.com");
  });

  it("rejects an obviously malformed domain", () => {
    for (const bad of ["not a domain", "http://example.com", "-leading-dash.com", "no-dot"]) {
      const { fieldErrors } = parseDomainSettingsForm(formData({ customDomain: bad }));
      expect(fieldErrors.customDomain, `expected "${bad}" to be rejected`).toBeTruthy();
    }
  });
});
