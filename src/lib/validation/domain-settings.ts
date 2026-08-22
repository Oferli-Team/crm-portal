import type { DomainSettingsFormState } from "@/types";

export type ParsedDomainSettingsInput = {
  customDomain: string | null;
};

// Deliberately permissive syntax validation only — no DNS/ownership check
// of any kind (this stage's own explicit "no real custom domain
// verification yet" constraint). Just enough to reject an obviously
// malformed value before it reaches storage.
const DOMAIN_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.[a-z0-9-]{1,63}(?<!-))+$/i;

export function parseDomainSettingsForm(formData: FormData): {
  values: ParsedDomainSettingsInput;
  fieldErrors: NonNullable<DomainSettingsFormState["fieldErrors"]>;
} {
  const raw = String(formData.get("customDomain") ?? "").trim().toLowerCase();
  const fieldErrors: NonNullable<DomainSettingsFormState["fieldErrors"]> = {};

  if (raw && !DOMAIN_PATTERN.test(raw)) {
    fieldErrors.customDomain = "Enter a valid domain (e.g. example.com).";
  }

  return { values: { customDomain: raw || null }, fieldErrors };
}
