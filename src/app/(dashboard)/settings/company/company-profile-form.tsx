"use client";

import { useActionState } from "react";
import { updateCompanyProfileAction } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import type { CompanyProfileFormState } from "@/types";
import type { CompanyProfileData } from "@/lib/organization-setup/company-profile";

const initialState: CompanyProfileFormState = { error: null };

/**
 * Sale-Ready Phase A.1 (Business Identity), PR3. Same form, same
 * `updateCompanyProfileAction`, same `useActionState` pattern, same
 * validation/error-display contract as before this stage — every field
 * that existed here already (legalName/displayName/country/currency/
 * timezone) keeps its exact `name`, `required`-ness, and error key.
 * What's new is purely organizational: the previously flat field list is
 * now grouped into `<fieldset>`/`<legend>` sections so the page reads as
 * "configure your business," not a list of unrelated settings —
 * `<fieldset>` is the correct native grouping for related inputs *within
 * one form* (as opposed to the separate `<section>` elements
 * settings/billing already uses to group unrelated cards on one page).
 *
 * currency/timezone don't belong to any of this stage's five named
 * Business Identity sections (they're locale/operational settings, not
 * identity) — kept in Business, right where they already sat, rather
 * than inventing a sixth, unrequested section for two fields.
 *
 * Every new field is optional (no `required` attribute, matching
 * validation/company-profile.ts's own nullable contract) — an OWNER can
 * save with none of them filled in, exactly as they always could before
 * this stage existed.
 */
export function CompanyProfileForm({
  profile,
  currencies,
  timezones,
}: {
  profile: CompanyProfileData;
  currencies: readonly string[];
  timezones: readonly string[];
}) {
  const [state, formAction, pending] = useActionState(updateCompanyProfileAction, initialState);

  return (
    <form action={formAction} className="mt-6 space-y-8 rounded-lg border border-gray-200 bg-white p-6">
      <fieldset className="space-y-4">
        <legend className="text-base font-semibold text-gray-900">Business</legend>

        <FormField label="Display / company name" htmlFor="displayName" required error={state.fieldErrors?.displayName}>
          <Input
            id="displayName"
            name="displayName"
            type="text"
            defaultValue={profile.displayName}
            aria-invalid={!!state.fieldErrors?.displayName}
            required
          />
        </FormField>

        <FormField label="Legal company name" htmlFor="legalName" required error={state.fieldErrors?.legalName}>
          <Input
            id="legalName"
            name="legalName"
            type="text"
            defaultValue={profile.legalName ?? ""}
            aria-invalid={!!state.fieldErrors?.legalName}
            required
          />
        </FormField>

        <FormField label="Currency" htmlFor="currency" required error={state.fieldErrors?.currency}>
          <select
            id="currency"
            name="currency"
            defaultValue={profile.currency ?? ""}
            aria-invalid={!!state.fieldErrors?.currency}
            required
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-black focus:ring-1 focus:ring-black focus:outline-none"
          >
            <option value="" disabled>
              Select a currency
            </option>
            {currencies.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="Time zone" htmlFor="timezone" required error={state.fieldErrors?.timezone}>
          <select
            id="timezone"
            name="timezone"
            defaultValue={profile.timezone ?? ""}
            aria-invalid={!!state.fieldErrors?.timezone}
            required
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-black focus:ring-1 focus:ring-black focus:outline-none"
          >
            <option value="" disabled>
              Select a time zone
            </option>
            {timezones.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </FormField>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-base font-semibold text-gray-900">Contact</legend>

        <FormField label="Support email" htmlFor="supportEmail" error={state.fieldErrors?.supportEmail}>
          <Input
            id="supportEmail"
            name="supportEmail"
            // Deliberately type="text", not type="email": a browser's own
            // native format validation would block submission before this
            // form's server-side validation ever runs, so a genuinely
            // invalid value would never reach parseCompanyProfileForm and
            // its own fieldError message would never have a chance to
            // display — the exact same reasoning as brandColor above,
            // and consistent with every other validated-but-optional
            // field on this form already being type="text".
            type="text"
            defaultValue={profile.supportEmail ?? ""}
            aria-invalid={!!state.fieldErrors?.supportEmail}
          />
        </FormField>

        <FormField label="Website" htmlFor="website" error={state.fieldErrors?.website}>
          <Input
            id="website"
            name="website"
            type="text"
            placeholder="https://"
            defaultValue={profile.website ?? ""}
            aria-invalid={!!state.fieldErrors?.website}
          />
        </FormField>

        <FormField label="Phone" htmlFor="phone" error={state.fieldErrors?.phone}>
          <Input
            id="phone"
            name="phone"
            type="text"
            defaultValue={profile.phone ?? ""}
            aria-invalid={!!state.fieldErrors?.phone}
          />
        </FormField>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-base font-semibold text-gray-900">Address</legend>

        <FormField label="Country" htmlFor="country" required error={state.fieldErrors?.country}>
          <Input
            id="country"
            name="country"
            type="text"
            defaultValue={profile.country ?? ""}
            aria-invalid={!!state.fieldErrors?.country}
            required
          />
        </FormField>

        <FormField label="Street address" htmlFor="streetAddress" error={state.fieldErrors?.streetAddress}>
          <Input
            id="streetAddress"
            name="streetAddress"
            type="text"
            defaultValue={profile.streetAddress ?? ""}
            aria-invalid={!!state.fieldErrors?.streetAddress}
          />
        </FormField>

        <FormField label="City" htmlFor="city" error={state.fieldErrors?.city}>
          <Input
            id="city"
            name="city"
            type="text"
            defaultValue={profile.city ?? ""}
            aria-invalid={!!state.fieldErrors?.city}
          />
        </FormField>

        <FormField label="State / Province" htmlFor="state" error={state.fieldErrors?.state}>
          <Input
            id="state"
            name="state"
            type="text"
            defaultValue={profile.state ?? ""}
            aria-invalid={!!state.fieldErrors?.state}
          />
        </FormField>

        <FormField label="Postal code" htmlFor="postalCode" error={state.fieldErrors?.postalCode}>
          <Input
            id="postalCode"
            name="postalCode"
            type="text"
            defaultValue={profile.postalCode ?? ""}
            aria-invalid={!!state.fieldErrors?.postalCode}
          />
        </FormField>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-base font-semibold text-gray-900">Tax</legend>

        <FormField label="Tax ID / VAT" htmlFor="taxId" error={state.fieldErrors?.taxId}>
          <Input
            id="taxId"
            name="taxId"
            type="text"
            defaultValue={profile.taxId ?? ""}
            aria-invalid={!!state.fieldErrors?.taxId}
          />
        </FormField>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-base font-semibold text-gray-900">Branding</legend>

        {/*
          Deliberately type="text", not type="color": a native color
          input has no "empty" state — it always submits a real hex
          value (defaulting to black), which would silently overwrite
          this nullable field with #000000 on every unrelated save for
          an organization that never set one. A plain text field keeps
          "unset" genuinely empty, the same as every other optional field
          on this form.
        */}
        <FormField label="Brand color" htmlFor="brandColor" error={state.fieldErrors?.brandColor}>
          <Input
            id="brandColor"
            name="brandColor"
            type="text"
            placeholder="#RRGGBB"
            defaultValue={profile.brandColor ?? ""}
            aria-invalid={!!state.fieldErrors?.brandColor}
          />
        </FormField>
      </fieldset>

      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}
      {state.message && (
        <p role="status" className="text-sm text-green-600">
          {state.message}
        </p>
      )}

      <Button type="submit" loading={pending}>
        {pending ? "Saving…" : "Save company profile"}
      </Button>
    </form>
  );
}
