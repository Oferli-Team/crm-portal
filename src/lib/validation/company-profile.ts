import type { CompanyProfileFormState } from "@/types";

export type ParsedCompanyProfileInput = {
  legalName: string;
  displayName: string;
  country: string;
  currency: string;
  timezone: string;

  // Sale-Ready Phase A.1 (Business Identity), PR2. All nine nullable —
  // an empty submission is always valid (see trimmedOrNull below); a
  // fieldError only ever appears when a *non-empty* value fails its own
  // format check. Backend-only for now: nothing in the current form
  // sends these fields yet, so formData.get() simply returns null for
  // each and every one of them parses to `null` — this PR changes
  // nothing about what a real, existing submission does today.
  supportEmail: string | null;
  website: string | null;
  phone: string | null;
  taxId: string | null;
  brandColor: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
};

// Real platform data, not a hand-maintained list — see
// src/lib/organization-setup/company-profile.ts's own schema comment for
// why this is validated in code (Intl) rather than a Prisma enum.
const VALID_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));
const VALID_TIMEZONES = new Set(Intl.supportedValuesOf("timeZone"));

// Same pattern already duplicated independently in
// src/lib/validation/{invitation,client}.ts and every signup/invite
// action in this codebase (no shared constant exists to import — each
// validation module keeps its own copy by established convention).
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const BRAND_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/** Trims, then treats an empty result as absent — the one normalization every optional Business Identity field shares (never applied to the five required fields above, which keep their own explicit required-ness checks). */
function trimmedOrNull(value: FormDataEntryValue | null): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** https-only, by explicit requirement — a bare `new URL()` parse would also accept http:// or any other scheme. */
function isValidHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function getSupportedCurrencies(): readonly string[] {
  return Array.from(VALID_CURRENCIES).sort();
}

export function getSupportedTimezones(): readonly string[] {
  return Array.from(VALID_TIMEZONES).sort();
}

export function parseCompanyProfileForm(formData: FormData): {
  values: ParsedCompanyProfileInput;
  fieldErrors: NonNullable<CompanyProfileFormState["fieldErrors"]>;
} {
  const legalName = String(formData.get("legalName") ?? "").trim();
  const displayName = String(formData.get("displayName") ?? "").trim();
  const country = String(formData.get("country") ?? "").trim();
  const currency = String(formData.get("currency") ?? "").trim().toUpperCase();
  const timezone = String(formData.get("timezone") ?? "").trim();

  const supportEmail = trimmedOrNull(formData.get("supportEmail"));
  const website = trimmedOrNull(formData.get("website"));
  const phone = trimmedOrNull(formData.get("phone"));
  const taxId = trimmedOrNull(formData.get("taxId"));
  const brandColor = trimmedOrNull(formData.get("brandColor"));
  const streetAddress = trimmedOrNull(formData.get("streetAddress"));
  const city = trimmedOrNull(formData.get("city"));
  const state = trimmedOrNull(formData.get("state"));
  const postalCode = trimmedOrNull(formData.get("postalCode"));

  const fieldErrors: NonNullable<CompanyProfileFormState["fieldErrors"]> = {};

  if (!legalName) {
    fieldErrors.legalName = "Legal company name is required.";
  }
  if (!displayName) {
    fieldErrors.displayName = "Display name is required.";
  }
  if (!country) {
    fieldErrors.country = "Country is required.";
  }
  if (!currency || !VALID_CURRENCIES.has(currency)) {
    fieldErrors.currency = "Select a valid currency.";
  }
  if (!timezone || !VALID_TIMEZONES.has(timezone)) {
    fieldErrors.timezone = "Select a valid time zone.";
  }

  // Optional fields: no required-ness check (null is always valid) —
  // only a format check, and only when a value was actually provided.
  if (supportEmail && !EMAIL_PATTERN.test(supportEmail)) {
    fieldErrors.supportEmail = "Enter a valid email address.";
  }
  if (website && !isValidHttpsUrl(website)) {
    fieldErrors.website = "Enter a valid https:// URL.";
  }
  if (brandColor && !BRAND_COLOR_PATTERN.test(brandColor)) {
    fieldErrors.brandColor = "Enter a color as #RRGGBB.";
  }
  // phone/taxId/streetAddress/city/state/postalCode: free-form, no format
  // validation beyond the trimmedOrNull normalization already applied —
  // same "descriptive, not validated against a lookup" precedent
  // `country` above and OrganizationPaymentDetails.accountNumber already
  // use (see prisma/schema.prisma's own comments on both).

  return {
    values: {
      legalName,
      displayName,
      country,
      currency,
      timezone,
      supportEmail,
      website,
      phone,
      taxId,
      brandColor,
      streetAddress,
      city,
      state,
      postalCode,
    },
    fieldErrors,
  };
}
