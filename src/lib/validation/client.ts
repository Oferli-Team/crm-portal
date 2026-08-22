import type { ClientFormState } from "@/types";

export const CLIENT_STATUSES = ["LEAD", "ACTIVE", "INACTIVE", "ARCHIVED"] as const;
export type ClientStatusValue = (typeof CLIENT_STATUSES)[number];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Invoice System Slice 1 (docs/invoicing-architecture.md §4.4) — optional
// Client billing-identity fields, used by a future invoice PDF's "Bill To"
// block. Max lengths mirror this codebase's own convention of a generous,
// non-punitive cap on free-text fields (no per-country format validation,
// same "descriptive, not validated against a lookup" precedent
// OrganizationProfile's equivalent fields already use).
export const CLIENT_BILLING_MAX_LENGTHS = {
  billingLegalName: 200,
  taxId: 100,
  streetAddress: 500,
  city: 100,
  state: 100,
  postalCode: 32,
  country: 100,
} as const;

export type ParsedClientInput = {
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  status: ClientStatusValue;
  billingLegalName: string | null;
  taxId: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
};

/** Trims, then treats an empty result as absent — matches src/lib/validation/company-profile.ts's own trimmedOrNull convention for optional fields. */
function trimmedOrNull(value: FormDataEntryValue | null): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseClientForm(formData: FormData): {
  values: ParsedClientInput;
  fieldErrors: NonNullable<ClientFormState["fieldErrors"]>;
} {
  const name = String(formData.get("name") ?? "").trim();
  const company = String(formData.get("company") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const status = String(formData.get("status") ?? "LEAD");

  const billingLegalName = trimmedOrNull(formData.get("billingLegalName"));
  const taxId = trimmedOrNull(formData.get("taxId"));
  const streetAddress = trimmedOrNull(formData.get("streetAddress"));
  const city = trimmedOrNull(formData.get("city"));
  const state = trimmedOrNull(formData.get("state"));
  const postalCode = trimmedOrNull(formData.get("postalCode"));
  const country = trimmedOrNull(formData.get("country"));

  const fieldErrors: NonNullable<ClientFormState["fieldErrors"]> = {};

  if (!name) {
    fieldErrors.name = "Name is required.";
  }

  if (email && !EMAIL_PATTERN.test(email)) {
    fieldErrors.email = "Enter a valid email address.";
  }

  const isValidStatus = CLIENT_STATUSES.includes(status as ClientStatusValue);
  if (!isValidStatus) {
    fieldErrors.status = "Select a valid status.";
  }

  // Optional billing fields: no required-ness check (null is always
  // valid) — only a max-length check, and only when a value was actually
  // provided.
  if (billingLegalName && billingLegalName.length > CLIENT_BILLING_MAX_LENGTHS.billingLegalName) {
    fieldErrors.billingLegalName = `Must be ${CLIENT_BILLING_MAX_LENGTHS.billingLegalName} characters or fewer.`;
  }
  if (taxId && taxId.length > CLIENT_BILLING_MAX_LENGTHS.taxId) {
    fieldErrors.taxId = `Must be ${CLIENT_BILLING_MAX_LENGTHS.taxId} characters or fewer.`;
  }
  if (streetAddress && streetAddress.length > CLIENT_BILLING_MAX_LENGTHS.streetAddress) {
    fieldErrors.streetAddress = `Must be ${CLIENT_BILLING_MAX_LENGTHS.streetAddress} characters or fewer.`;
  }
  if (city && city.length > CLIENT_BILLING_MAX_LENGTHS.city) {
    fieldErrors.city = `Must be ${CLIENT_BILLING_MAX_LENGTHS.city} characters or fewer.`;
  }
  if (state && state.length > CLIENT_BILLING_MAX_LENGTHS.state) {
    fieldErrors.state = `Must be ${CLIENT_BILLING_MAX_LENGTHS.state} characters or fewer.`;
  }
  if (postalCode && postalCode.length > CLIENT_BILLING_MAX_LENGTHS.postalCode) {
    fieldErrors.postalCode = `Must be ${CLIENT_BILLING_MAX_LENGTHS.postalCode} characters or fewer.`;
  }
  if (country && country.length > CLIENT_BILLING_MAX_LENGTHS.country) {
    fieldErrors.country = `Must be ${CLIENT_BILLING_MAX_LENGTHS.country} characters or fewer.`;
  }

  return {
    values: {
      name,
      company: company || null,
      email: email || null,
      phone: phone || null,
      status: isValidStatus ? (status as ClientStatusValue) : "LEAD",
      billingLegalName,
      taxId,
      streetAddress,
      city,
      state,
      postalCode,
      country,
    },
    fieldErrors,
  };
}
