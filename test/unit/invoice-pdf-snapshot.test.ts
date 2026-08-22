import { describe, expect, it, vi } from "vitest";

// src/lib/invoices/pdf/snapshot-types.ts imports the real "server-only"
// marker package, which throws outside Next's own build — see
// test/unit/cron-auth.test.ts's own header comment for the identical
// precedent.
vi.mock("server-only", () => ({}));

import {
  buildIssuerSnapshotV1,
  buildRecipientSnapshotV1,
  parseIssuerSnapshot,
  parseRecipientSnapshot,
  type InvoiceIssuerSnapshotV1,
  type InvoiceRecipientSnapshotV1,
} from "@/lib/invoices/pdf/snapshot-types";

const VALID_LOGO_INCLUDED = {
  included: true,
  bucket: "logos",
  path: "organizations/org-1/logo.png",
  contentType: "image/png",
  sha256: "a".repeat(64),
} as const;

const VALID_LOGO_EXCLUDED = { included: false, reason: "no_logo_configured" } as const;

function validIssuerSnapshot(overrides: Partial<InvoiceIssuerSnapshotV1> = {}): InvoiceIssuerSnapshotV1 {
  return {
    schemaVersion: 1,
    legalName: "Acme Corp",
    address: { streetAddress: "1 Main St", city: "Springfield", state: "IL", postalCode: "62701" },
    country: "US",
    taxId: "12-3456789",
    supportEmail: "support@acme.test",
    phone: "+1-555-0100",
    website: "https://acme.test",
    brandColor: "#336699",
    payment: {
      bankName: "First Bank",
      accountHolder: "Acme Corp",
      accountNumber: "000123456",
      swiftBic: "FBUS1234",
      paymentInstructions: "Please include invoice number.",
    },
    logo: VALID_LOGO_INCLUDED,
    ...overrides,
  };
}

function validRecipientSnapshot(overrides: Partial<InvoiceRecipientSnapshotV1> = {}): InvoiceRecipientSnapshotV1 {
  return {
    schemaVersion: 1,
    billingName: "Jane Doe",
    email: "jane@example.test",
    address: { streetAddress: "2 Elm St", city: "Metropolis", state: "NY", postalCode: "10001" },
    country: "US",
    taxId: "98-7654321",
    ...overrides,
  };
}

describe("buildIssuerSnapshotV1", () => {
  it("uses OrganizationProfile.legalName when a profile row exists", () => {
    const snapshot = buildIssuerSnapshotV1({
      organizationName: "Fallback Org Name",
      profile: {
        legalName: "Profile Legal Name",
        country: "US",
        taxId: null,
        supportEmail: null,
        phone: null,
        website: null,
        brandColor: null,
        streetAddress: null,
        city: null,
        state: null,
        postalCode: null,
      },
      paymentDetails: null,
      logo: VALID_LOGO_EXCLUDED,
    });
    expect(snapshot.legalName).toBe("Profile Legal Name");
  });

  it("falls back to Organization.name when no OrganizationProfile row exists", () => {
    const snapshot = buildIssuerSnapshotV1({
      organizationName: "Fallback Org Name",
      profile: null,
      paymentDetails: null,
      logo: VALID_LOGO_EXCLUDED,
    });
    expect(snapshot.legalName).toBe("Fallback Org Name");
    expect(snapshot.address).toEqual({ streetAddress: null, city: null, state: null, postalCode: null });
    expect(snapshot.country).toBeNull();
    expect(snapshot.taxId).toBeNull();
    expect(snapshot.supportEmail).toBeNull();
    expect(snapshot.phone).toBeNull();
    expect(snapshot.website).toBeNull();
    expect(snapshot.brandColor).toBeNull();
  });

  it("payment is null when no OrganizationPaymentDetails row exists", () => {
    const snapshot = buildIssuerSnapshotV1({
      organizationName: "Org",
      profile: null,
      paymentDetails: null,
      logo: VALID_LOGO_EXCLUDED,
    });
    expect(snapshot.payment).toBeNull();
  });

  it("payment is populated exactly from the provided OrganizationPaymentDetails row", () => {
    const snapshot = buildIssuerSnapshotV1({
      organizationName: "Org",
      profile: null,
      paymentDetails: {
        bankName: "Bank",
        accountHolder: "Holder",
        accountNumber: "123",
        swiftBic: "ABCD",
        paymentInstructions: null,
      },
      logo: VALID_LOGO_EXCLUDED,
    });
    expect(snapshot.payment).toEqual({
      bankName: "Bank",
      accountHolder: "Holder",
      accountNumber: "123",
      swiftBic: "ABCD",
      paymentInstructions: null,
    });
  });

  it("logo provenance passes through exactly what the caller supplies", () => {
    const snapshot = buildIssuerSnapshotV1({
      organizationName: "Org",
      profile: null,
      paymentDetails: null,
      logo: VALID_LOGO_INCLUDED,
    });
    expect(snapshot.logo).toEqual(VALID_LOGO_INCLUDED);
  });

  it("schemaVersion is always exactly 1", () => {
    const snapshot = buildIssuerSnapshotV1({
      organizationName: "Org",
      profile: null,
      paymentDetails: null,
      logo: VALID_LOGO_EXCLUDED,
    });
    expect(snapshot.schemaVersion).toBe(1);
  });
});

describe("buildRecipientSnapshotV1", () => {
  it("billingLegalName wins when present", () => {
    const snapshot = buildRecipientSnapshotV1({
      billingLegalName: "Legal Name Inc.",
      company: "Company Name",
      name: "Personal Name",
      email: null,
      taxId: null,
      streetAddress: null,
      city: null,
      state: null,
      postalCode: null,
      country: null,
    });
    expect(snapshot.billingName).toBe("Legal Name Inc.");
  });

  it("falls back to company when billingLegalName is null", () => {
    const snapshot = buildRecipientSnapshotV1({
      billingLegalName: null,
      company: "Company Name",
      name: "Personal Name",
      email: null,
      taxId: null,
      streetAddress: null,
      city: null,
      state: null,
      postalCode: null,
      country: null,
    });
    expect(snapshot.billingName).toBe("Company Name");
  });

  it("falls back to name when both billingLegalName and company are null", () => {
    const snapshot = buildRecipientSnapshotV1({
      billingLegalName: null,
      company: null,
      name: "Personal Name",
      email: null,
      taxId: null,
      streetAddress: null,
      city: null,
      state: null,
      postalCode: null,
      country: null,
    });
    expect(snapshot.billingName).toBe("Personal Name");
  });

  it("missing optional address/tax/email fields become null", () => {
    const snapshot = buildRecipientSnapshotV1({
      billingLegalName: null,
      company: null,
      name: "Personal Name",
      email: null,
      taxId: null,
      streetAddress: null,
      city: null,
      state: null,
      postalCode: null,
      country: null,
    });
    expect(snapshot.email).toBeNull();
    expect(snapshot.taxId).toBeNull();
    expect(snapshot.address).toEqual({ streetAddress: null, city: null, state: null, postalCode: null });
    expect(snapshot.country).toBeNull();
  });

  it("schemaVersion is always exactly 1", () => {
    const snapshot = buildRecipientSnapshotV1({
      billingLegalName: null,
      company: null,
      name: "X",
      email: null,
      taxId: null,
      streetAddress: null,
      city: null,
      state: null,
      postalCode: null,
      country: null,
    });
    expect(snapshot.schemaVersion).toBe(1);
  });
});

describe("parseIssuerSnapshot", () => {
  it("accepts a well-formed snapshot with a fully-included logo", () => {
    const result = parseIssuerSnapshot(validIssuerSnapshot());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot).toEqual(validIssuerSnapshot());
  });

  it("accepts a well-formed snapshot with a fully-excluded logo and null payment", () => {
    const raw = validIssuerSnapshot({ payment: null, logo: VALID_LOGO_EXCLUDED });
    const result = parseIssuerSnapshot(raw);
    expect(result.ok).toBe(true);
  });

  it("rejects a non-object value", () => {
    expect(parseIssuerSnapshot("not an object")).toEqual({ ok: false, reason: "MALFORMED" });
    expect(parseIssuerSnapshot(null)).toEqual({ ok: false, reason: "MALFORMED" });
    expect(parseIssuerSnapshot(42)).toEqual({ ok: false, reason: "MALFORMED" });
    expect(parseIssuerSnapshot([])).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects a missing schemaVersion as MALFORMED, not UNKNOWN_SCHEMA_VERSION", () => {
    const raw: Record<string, unknown> = validIssuerSnapshot();
    delete raw.schemaVersion;
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects an unrecognized schemaVersion as UNKNOWN_SCHEMA_VERSION", () => {
    const raw = { ...validIssuerSnapshot(), schemaVersion: 2 };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "UNKNOWN_SCHEMA_VERSION" });
  });

  it("rejects an unexpected top-level key instead of silently ignoring it", () => {
    const raw = { ...validIssuerSnapshot(), unexpectedKey: "sneaky" };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects an unexpected key inside the address object", () => {
    const raw = { ...validIssuerSnapshot(), address: { ...validIssuerSnapshot().address, extra: "x" } };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects an unexpected key inside the payment object", () => {
    const raw = { ...validIssuerSnapshot(), payment: { ...validIssuerSnapshot().payment, extra: "x" } };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects an unexpected key inside an included logo object", () => {
    const raw = { ...validIssuerSnapshot(), logo: { ...VALID_LOGO_INCLUDED, extra: "x" } };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects an unexpected key inside an excluded logo object", () => {
    const raw = { ...validIssuerSnapshot(), logo: { ...VALID_LOGO_EXCLUDED, extra: "x" } };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects an empty legalName", () => {
    const raw = { ...validIssuerSnapshot(), legalName: "" };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects a non-string legalName", () => {
    const raw = { ...validIssuerSnapshot(), legalName: 123 };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects a malformed address (missing key)", () => {
    const raw = { ...validIssuerSnapshot(), address: { streetAddress: null, city: null, state: null } };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects a non-null non-string nullable field (country)", () => {
    const raw = { ...validIssuerSnapshot(), country: 42 };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("accepts null for every nullable top-level field", () => {
    const raw = {
      ...validIssuerSnapshot(),
      country: null,
      taxId: null,
      supportEmail: null,
      phone: null,
      website: null,
      brandColor: null,
    };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: true, snapshot: raw });
  });

  it("rejects a brandColor that is not a valid #RRGGBB hex value", () => {
    const raw = { ...validIssuerSnapshot(), brandColor: "blue" };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects a brandColor missing the leading #", () => {
    const raw = { ...validIssuerSnapshot(), brandColor: "336699" };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("accepts an uppercase-hex brandColor (case-insensitive hex digits)", () => {
    const raw = { ...validIssuerSnapshot(), brandColor: "#336699".toUpperCase() };
    expect(parseIssuerSnapshot(raw).ok).toBe(true);
  });

  it("rejects payment missing a required field", () => {
    const raw = {
      ...validIssuerSnapshot(),
      payment: { bankName: "Bank", accountHolder: "Holder", accountNumber: "1", swiftBic: "ABCD" },
    };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects payment with an empty required string field", () => {
    const raw = { ...validIssuerSnapshot(), payment: { ...validIssuerSnapshot().payment!, bankName: "" } };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects a logo bucket other than the literal 'logos'", () => {
    const raw = { ...validIssuerSnapshot(), logo: { ...VALID_LOGO_INCLUDED, bucket: "attachments" } };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects an empty logo path", () => {
    const raw = { ...validIssuerSnapshot(), logo: { ...VALID_LOGO_INCLUDED, path: "" } };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects a disallowed logo MIME type", () => {
    const raw = { ...validIssuerSnapshot(), logo: { ...VALID_LOGO_INCLUDED, contentType: "image/svg+xml" } };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it.each(["image/png", "image/jpeg", "image/webp"] as const)("accepts allowed logo MIME type %s", (contentType) => {
    const raw = { ...validIssuerSnapshot(), logo: { ...VALID_LOGO_INCLUDED, contentType } };
    expect(parseIssuerSnapshot(raw).ok).toBe(true);
  });

  it("rejects a sha256 shorter than 64 hex characters", () => {
    const raw = { ...validIssuerSnapshot(), logo: { ...VALID_LOGO_INCLUDED, sha256: "a".repeat(63) } };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects a sha256 longer than 64 hex characters", () => {
    const raw = { ...validIssuerSnapshot(), logo: { ...VALID_LOGO_INCLUDED, sha256: "a".repeat(65) } };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects an uppercase sha256 (must already be lowercase/normalized)", () => {
    const raw = { ...validIssuerSnapshot(), logo: { ...VALID_LOGO_INCLUDED, sha256: "A".repeat(64) } };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects a sha256 containing a non-hex character", () => {
    const raw = { ...validIssuerSnapshot(), logo: { ...VALID_LOGO_INCLUDED, sha256: "g".repeat(64) } };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects an excluded-logo reason outside the allowed enum", () => {
    const raw = { ...validIssuerSnapshot(), logo: { included: false, reason: "something_else" } };
    expect(parseIssuerSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("never throws for deeply malformed/unrelated JSON shapes", () => {
    expect(() => parseIssuerSnapshot({ random: "shape", nested: { a: [1, 2, 3] } })).not.toThrow();
    expect(() => parseIssuerSnapshot(undefined)).not.toThrow();
    expect(() => parseIssuerSnapshot(true)).not.toThrow();
  });
});

describe("parseRecipientSnapshot", () => {
  it("accepts a well-formed recipient snapshot", () => {
    const result = parseRecipientSnapshot(validRecipientSnapshot());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot).toEqual(validRecipientSnapshot());
  });

  it("rejects a non-object value", () => {
    expect(parseRecipientSnapshot("nope")).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects a missing schemaVersion as MALFORMED", () => {
    const raw: Record<string, unknown> = validRecipientSnapshot();
    delete raw.schemaVersion;
    expect(parseRecipientSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects an unrecognized schemaVersion as UNKNOWN_SCHEMA_VERSION", () => {
    const raw = { ...validRecipientSnapshot(), schemaVersion: 99 };
    expect(parseRecipientSnapshot(raw)).toEqual({ ok: false, reason: "UNKNOWN_SCHEMA_VERSION" });
  });

  it("rejects an unexpected top-level key", () => {
    const raw = { ...validRecipientSnapshot(), extra: "sneaky" };
    expect(parseRecipientSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects an empty billingName", () => {
    const raw = { ...validRecipientSnapshot(), billingName: "" };
    expect(parseRecipientSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("accepts null for every nullable field", () => {
    const raw = { ...validRecipientSnapshot(), email: null, country: null, taxId: null };
    expect(parseRecipientSnapshot(raw)).toEqual({ ok: true, snapshot: raw });
  });

  it("rejects a non-string non-null email", () => {
    const raw = { ...validRecipientSnapshot(), email: 42 };
    expect(parseRecipientSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects a malformed nested address", () => {
    const raw = { ...validRecipientSnapshot(), address: { streetAddress: null } };
    expect(parseRecipientSnapshot(raw)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("never throws for arbitrary untrusted input", () => {
    expect(() => parseRecipientSnapshot(null)).not.toThrow();
    expect(() => parseRecipientSnapshot([1, 2, 3])).not.toThrow();
    expect(() => parseRecipientSnapshot({})).not.toThrow();
  });
});
