"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { FormField } from "@/components/ui/form-field";
import { CLIENT_STATUSES, CLIENT_BILLING_MAX_LENGTHS } from "@/lib/validation/client";
import type { ClientFormState } from "@/types";

const initialState: ClientFormState = { error: null };

type ClientFormDefaults = {
  name?: string;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  status?: string;
  billingLegalName?: string | null;
  taxId?: string | null;
  streetAddress?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
};

export function ClientForm({
  action,
  defaultValues,
  submitLabel = "Create client",
  pendingLabel = "Creating…",
}: {
  action: (
    prevState: ClientFormState,
    formData: FormData,
  ) => Promise<ClientFormState>;
  defaultValues?: ClientFormDefaults;
  submitLabel?: string;
  pendingLabel?: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <FormField label="Name" htmlFor="name" required error={state.fieldErrors?.name}>
        <Input
          id="name"
          name="name"
          defaultValue={defaultValues?.name}
          required
          aria-invalid={!!state.fieldErrors?.name}
          aria-describedby={state.fieldErrors?.name ? "name-error" : undefined}
        />
      </FormField>

      <FormField label="Company" htmlFor="company">
        <Input
          id="company"
          name="company"
          defaultValue={defaultValues?.company ?? ""}
        />
      </FormField>

      <FormField label="Email" htmlFor="email" error={state.fieldErrors?.email}>
        <Input
          id="email"
          name="email"
          type="email"
          defaultValue={defaultValues?.email ?? ""}
          aria-invalid={!!state.fieldErrors?.email}
          aria-describedby={state.fieldErrors?.email ? "email-error" : undefined}
        />
      </FormField>

      <FormField label="Phone" htmlFor="phone">
        <Input
          id="phone"
          name="phone"
          type="tel"
          defaultValue={defaultValues?.phone ?? ""}
        />
      </FormField>

      <FormField label="Status" htmlFor="status" error={state.fieldErrors?.status}>
        <Select
          id="status"
          name="status"
          defaultValue={defaultValues?.status ?? "LEAD"}
          aria-invalid={!!state.fieldErrors?.status}
          aria-describedby={state.fieldErrors?.status ? "status-error" : undefined}
        >
          {CLIENT_STATUSES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </FormField>

      {/*
        Invoice System Slice 1 (docs/invoicing-architecture.md §4.4/§8) —
        optional billing identity used by a future invoice PDF's "Bill To"
        block. No invoice UI exists yet in this slice; this is the only UI
        Slice 1 adds. All seven fields are optional — an empty submission
        (or leaving every field blank on an existing client) is always
        valid; a blank field is normalized to null, never an empty string.
      */}
      <fieldset className="space-y-4 border-t border-gray-200 pt-4">
        <legend className="text-base font-semibold text-gray-900">Billing details</legend>
        <p className="text-sm text-gray-500">
          Optional — used on future invoices for this client. Leave blank if not needed.
        </p>

        <FormField label="Billing legal name" htmlFor="billingLegalName" error={state.fieldErrors?.billingLegalName}>
          <Input
            id="billingLegalName"
            name="billingLegalName"
            type="text"
            maxLength={CLIENT_BILLING_MAX_LENGTHS.billingLegalName}
            defaultValue={defaultValues?.billingLegalName ?? ""}
            aria-invalid={!!state.fieldErrors?.billingLegalName}
            aria-describedby={state.fieldErrors?.billingLegalName ? "billingLegalName-error" : undefined}
          />
        </FormField>

        <FormField label="Tax / VAT ID" htmlFor="taxId" error={state.fieldErrors?.taxId}>
          <Input
            id="taxId"
            name="taxId"
            type="text"
            maxLength={CLIENT_BILLING_MAX_LENGTHS.taxId}
            defaultValue={defaultValues?.taxId ?? ""}
            aria-invalid={!!state.fieldErrors?.taxId}
            aria-describedby={state.fieldErrors?.taxId ? "taxId-error" : undefined}
          />
        </FormField>

        <FormField label="Street address" htmlFor="streetAddress" error={state.fieldErrors?.streetAddress}>
          <Input
            id="streetAddress"
            name="streetAddress"
            type="text"
            maxLength={CLIENT_BILLING_MAX_LENGTHS.streetAddress}
            defaultValue={defaultValues?.streetAddress ?? ""}
            aria-invalid={!!state.fieldErrors?.streetAddress}
            aria-describedby={state.fieldErrors?.streetAddress ? "streetAddress-error" : undefined}
          />
        </FormField>

        <FormField label="City" htmlFor="city" error={state.fieldErrors?.city}>
          <Input
            id="city"
            name="city"
            type="text"
            maxLength={CLIENT_BILLING_MAX_LENGTHS.city}
            defaultValue={defaultValues?.city ?? ""}
            aria-invalid={!!state.fieldErrors?.city}
            aria-describedby={state.fieldErrors?.city ? "city-error" : undefined}
          />
        </FormField>

        <FormField label="State / region" htmlFor="state" error={state.fieldErrors?.state}>
          <Input
            id="state"
            name="state"
            type="text"
            maxLength={CLIENT_BILLING_MAX_LENGTHS.state}
            defaultValue={defaultValues?.state ?? ""}
            aria-invalid={!!state.fieldErrors?.state}
            aria-describedby={state.fieldErrors?.state ? "state-error" : undefined}
          />
        </FormField>

        <FormField label="Postal code" htmlFor="postalCode" error={state.fieldErrors?.postalCode}>
          <Input
            id="postalCode"
            name="postalCode"
            type="text"
            maxLength={CLIENT_BILLING_MAX_LENGTHS.postalCode}
            defaultValue={defaultValues?.postalCode ?? ""}
            aria-invalid={!!state.fieldErrors?.postalCode}
            aria-describedby={state.fieldErrors?.postalCode ? "postalCode-error" : undefined}
          />
        </FormField>

        <FormField label="Country" htmlFor="country" error={state.fieldErrors?.country}>
          <Input
            id="country"
            name="country"
            type="text"
            maxLength={CLIENT_BILLING_MAX_LENGTHS.country}
            defaultValue={defaultValues?.country ?? ""}
            aria-invalid={!!state.fieldErrors?.country}
            aria-describedby={state.fieldErrors?.country ? "country-error" : undefined}
          />
        </FormField>
      </fieldset>

      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}

      <div className="flex gap-3 pt-2">
        <Button type="submit" loading={pending}>
          {pending ? pendingLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}
