import "server-only";

/**
 * Invoice System Official Slice 3, sub-PR 3a — the persisted Snapshot V1
 * contract (docs/invoicing-architecture.md §7, "Second Corrected Design
 * Report" §7/§13). This module is pure with respect to I/O: the builder
 * functions accept already-fetched plain data (never a Prisma model
 * object, never a database/Storage/network call of their own), and the
 * parser functions accept `unknown` (never trust stored JSON merely
 * because a database wrote it) and never throw.
 *
 * `import "server-only"` is present because this module is exclusively
 * reachable from the Issue service layer (src/lib/invoices/pdf/issue-
 * invoice.ts, sub-PR 3b) and the future Legacy Archive service (3c) — it
 * has no reason to ever be imported by a Client Component, even though
 * nothing in it is Node-only or secret-bearing on its own.
 */

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const ALLOWED_LOGO_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export type AllowedLogoContentType = (typeof ALLOWED_LOGO_CONTENT_TYPES)[number];

export type InvoiceAddressV1 = {
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
};

export type InvoiceIssuerPaymentInstructionsV1 = {
  bankName: string;
  accountHolder: string;
  accountNumber: string;
  swiftBic: string;
  paymentInstructions: string | null;
} | null;

/**
 * The logo's persisted provenance record — never a permanent URL (see the
 * "Second Corrected Design Report" §7's own rejection of that shape).
 * `bucket`/`path` are a structured, allowlisted reference; `sha256` is a
 * content hash of exactly the bytes fed into the renderer at issuance
 * time, letting a future audit confirm what was actually embedded without
 * re-fetching anything. `included: false` with an honest `reason` never
 * falsely implies a logo was rendered when retrieval actually failed.
 */
export type InvoiceLogoProvenanceV1 =
  | { included: true; bucket: "logos"; path: string; contentType: AllowedLogoContentType; sha256: string }
  | { included: false; reason: "no_logo_configured" | "fetch_failed" | "invalid_content" };

export type InvoiceIssuerSnapshotV1 = {
  schemaVersion: 1;
  legalName: string;
  address: InvoiceAddressV1;
  country: string | null;
  taxId: string | null;
  supportEmail: string | null;
  phone: string | null;
  website: string | null;
  /** Validated `#RRGGBB` hex or null — never an unvalidated free-form string (see BRAND_COLOR_PATTERN's identical precedent in src/lib/validation/company-profile.ts). */
  brandColor: string | null;
  payment: InvoiceIssuerPaymentInstructionsV1;
  logo: InvoiceLogoProvenanceV1;
};

export type InvoiceRecipientSnapshotV1 = {
  schemaVersion: 1;
  billingName: string;
  email: string | null;
  address: InvoiceAddressV1;
  country: string | null;
  taxId: string | null;
};

export type ParsedIssuerSnapshot =
  | { ok: true; snapshot: InvoiceIssuerSnapshotV1 }
  | { ok: false; reason: "UNKNOWN_SCHEMA_VERSION" | "MALFORMED" };

export type ParsedRecipientSnapshot =
  | { ok: true; snapshot: InvoiceRecipientSnapshotV1 }
  | { ok: false; reason: "UNKNOWN_SCHEMA_VERSION" | "MALFORMED" };

// ---------------------------------------------------------------------------
// Builders — deterministic, no I/O. Callers pass already-fetched plain data;
// none of these functions performs a database/Storage/network read of its own.
// ---------------------------------------------------------------------------

/**
 * Issuer legal name fallback rule: `OrganizationProfile.legalName` when a
 * profile row exists, else `Organization.name` (always present —
 * `Organization.name` is a required column). Never null, never a fabricated
 * placeholder.
 */
export function buildIssuerSnapshotV1(input: {
  organizationName: string;
  profile: {
    legalName: string;
    country: string | null;
    taxId: string | null;
    supportEmail: string | null;
    phone: string | null;
    website: string | null;
    brandColor: string | null;
    streetAddress: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
  } | null;
  paymentDetails: {
    bankName: string;
    accountHolder: string;
    accountNumber: string;
    swiftBic: string;
    paymentInstructions: string | null;
  } | null;
  logo: InvoiceLogoProvenanceV1;
}): InvoiceIssuerSnapshotV1 {
  const { profile } = input;

  return {
    schemaVersion: 1,
    legalName: profile?.legalName ?? input.organizationName,
    address: {
      streetAddress: profile?.streetAddress ?? null,
      city: profile?.city ?? null,
      state: profile?.state ?? null,
      postalCode: profile?.postalCode ?? null,
    },
    country: profile?.country ?? null,
    taxId: profile?.taxId ?? null,
    supportEmail: profile?.supportEmail ?? null,
    phone: profile?.phone ?? null,
    website: profile?.website ?? null,
    brandColor: profile?.brandColor ?? null,
    payment: input.paymentDetails
      ? {
          bankName: input.paymentDetails.bankName,
          accountHolder: input.paymentDetails.accountHolder,
          accountNumber: input.paymentDetails.accountNumber,
          swiftBic: input.paymentDetails.swiftBic,
          paymentInstructions: input.paymentDetails.paymentInstructions ?? null,
        }
      : null,
    logo: input.logo,
  };
}

/**
 * Recipient billing name fallback rule:
 * `billingLegalName ?? company ?? name` — `Client.name` is a required
 * column, so this is never null.
 */
export function buildRecipientSnapshotV1(client: {
  billingLegalName: string | null;
  company: string | null;
  name: string;
  email: string | null;
  taxId: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
}): InvoiceRecipientSnapshotV1 {
  return {
    schemaVersion: 1,
    billingName: client.billingLegalName ?? client.company ?? client.name,
    email: client.email ?? null,
    address: {
      streetAddress: client.streetAddress ?? null,
      city: client.city ?? null,
      state: client.state ?? null,
      postalCode: client.postalCode ?? null,
    },
    country: client.country ?? null,
    taxId: client.taxId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Strict parsers — accept `unknown`, never throw, reject unrecognized shapes
// (including unexpected keys) rather than silently ignoring them.
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(obj).every((key) => allowedSet.has(key));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const ADDRESS_KEYS = ["streetAddress", "city", "state", "postalCode"] as const;

function parseAddress(value: unknown): InvoiceAddressV1 | null {
  if (!isPlainObject(value)) return null;
  if (!hasExactKeys(value, ADDRESS_KEYS)) return null;
  if (!ADDRESS_KEYS.every((key) => isNullableString(value[key]))) return null;
  return {
    streetAddress: value.streetAddress as string | null,
    city: value.city as string | null,
    state: value.state as string | null,
    postalCode: value.postalCode as string | null,
  };
}

const PAYMENT_KEYS = ["bankName", "accountHolder", "accountNumber", "swiftBic", "paymentInstructions"] as const;

function parsePayment(value: unknown): InvoiceIssuerPaymentInstructionsV1 | undefined {
  if (value === null) return null;
  if (!isPlainObject(value)) return undefined;
  if (!hasExactKeys(value, PAYMENT_KEYS)) return undefined;
  if (
    !isNonEmptyString(value.bankName) ||
    !isNonEmptyString(value.accountHolder) ||
    !isNonEmptyString(value.accountNumber) ||
    !isNonEmptyString(value.swiftBic) ||
    !isNullableString(value.paymentInstructions)
  ) {
    return undefined;
  }
  return {
    bankName: value.bankName,
    accountHolder: value.accountHolder,
    accountNumber: value.accountNumber,
    swiftBic: value.swiftBic,
    paymentInstructions: value.paymentInstructions,
  };
}

const LOGO_INCLUDED_KEYS = ["included", "bucket", "path", "contentType", "sha256"] as const;
const LOGO_EXCLUDED_KEYS = ["included", "reason"] as const;
const LOGO_EXCLUDED_REASONS = ["no_logo_configured", "fetch_failed", "invalid_content"] as const;

function parseLogo(value: unknown): InvoiceLogoProvenanceV1 | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.included !== "boolean") return undefined;

  if (value.included === true) {
    if (!hasExactKeys(value, LOGO_INCLUDED_KEYS)) return undefined;
    if (value.bucket !== "logos") return undefined;
    if (!isNonEmptyString(value.path)) return undefined;
    if (typeof value.contentType !== "string" || !(ALLOWED_LOGO_CONTENT_TYPES as readonly string[]).includes(value.contentType)) {
      return undefined;
    }
    if (typeof value.sha256 !== "string" || !SHA256_HEX_PATTERN.test(value.sha256)) return undefined;
    return {
      included: true,
      bucket: "logos",
      path: value.path,
      contentType: value.contentType as AllowedLogoContentType,
      sha256: value.sha256,
    };
  }

  if (!hasExactKeys(value, LOGO_EXCLUDED_KEYS)) return undefined;
  if (typeof value.reason !== "string" || !(LOGO_EXCLUDED_REASONS as readonly string[]).includes(value.reason)) {
    return undefined;
  }
  return { included: false, reason: value.reason as (typeof LOGO_EXCLUDED_REASONS)[number] };
}

const ISSUER_KEYS = [
  "schemaVersion",
  "legalName",
  "address",
  "country",
  "taxId",
  "supportEmail",
  "phone",
  "website",
  "brandColor",
  "payment",
  "logo",
] as const;

export function parseIssuerSnapshot(raw: unknown): ParsedIssuerSnapshot {
  if (!isPlainObject(raw)) return { ok: false, reason: "MALFORMED" };
  if (raw.schemaVersion !== 1) {
    return { ok: false, reason: raw.schemaVersion === undefined ? "MALFORMED" : "UNKNOWN_SCHEMA_VERSION" };
  }
  if (!hasExactKeys(raw, ISSUER_KEYS)) return { ok: false, reason: "MALFORMED" };
  if (!isNonEmptyString(raw.legalName)) return { ok: false, reason: "MALFORMED" };

  const address = parseAddress(raw.address);
  if (address === null) return { ok: false, reason: "MALFORMED" };

  if (!isNullableString(raw.country) || !isNullableString(raw.taxId) || !isNullableString(raw.supportEmail) || !isNullableString(raw.phone) || !isNullableString(raw.website)) {
    return { ok: false, reason: "MALFORMED" };
  }
  if (raw.brandColor !== null && (typeof raw.brandColor !== "string" || !HEX_COLOR_PATTERN.test(raw.brandColor))) {
    return { ok: false, reason: "MALFORMED" };
  }

  const payment = parsePayment(raw.payment);
  if (payment === undefined) return { ok: false, reason: "MALFORMED" };

  const logo = parseLogo(raw.logo);
  if (logo === undefined) return { ok: false, reason: "MALFORMED" };

  return {
    ok: true,
    snapshot: {
      schemaVersion: 1,
      legalName: raw.legalName,
      address,
      country: raw.country,
      taxId: raw.taxId,
      supportEmail: raw.supportEmail,
      phone: raw.phone,
      website: raw.website,
      brandColor: raw.brandColor as string | null,
      payment,
      logo,
    },
  };
}

const RECIPIENT_KEYS = ["schemaVersion", "billingName", "email", "address", "country", "taxId"] as const;

export function parseRecipientSnapshot(raw: unknown): ParsedRecipientSnapshot {
  if (!isPlainObject(raw)) return { ok: false, reason: "MALFORMED" };
  if (raw.schemaVersion !== 1) {
    return { ok: false, reason: raw.schemaVersion === undefined ? "MALFORMED" : "UNKNOWN_SCHEMA_VERSION" };
  }
  if (!hasExactKeys(raw, RECIPIENT_KEYS)) return { ok: false, reason: "MALFORMED" };
  if (!isNonEmptyString(raw.billingName)) return { ok: false, reason: "MALFORMED" };
  if (!isNullableString(raw.email) || !isNullableString(raw.country) || !isNullableString(raw.taxId)) {
    return { ok: false, reason: "MALFORMED" };
  }

  const address = parseAddress(raw.address);
  if (address === null) return { ok: false, reason: "MALFORMED" };

  return {
    ok: true,
    snapshot: {
      schemaVersion: 1,
      billingName: raw.billingName,
      email: raw.email,
      address,
      country: raw.country,
      taxId: raw.taxId,
    },
  };
}
