"use client";

import { useActionState } from "react";
import { updatePaymentDetailsAction } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import type { PaymentDetailsFormState } from "@/types";
import type { PaymentDetailsData } from "@/lib/organization-setup/payment-details";

const initialState: PaymentDetailsFormState = { error: null };

export function PaymentDetailsForm({ details }: { details: PaymentDetailsData }) {
  const [state, formAction, pending] = useActionState(updatePaymentDetailsAction, initialState);

  return (
    <form action={formAction} className="mt-6 space-y-4 rounded-lg border border-gray-200 bg-white p-6">
      <FormField label="Bank name" htmlFor="bankName" required error={state.fieldErrors?.bankName}>
        <Input
          id="bankName"
          name="bankName"
          type="text"
          defaultValue={details?.bankName ?? ""}
          aria-invalid={!!state.fieldErrors?.bankName}
          required
        />
      </FormField>

      <FormField label="Account holder" htmlFor="accountHolder" required error={state.fieldErrors?.accountHolder}>
        <Input
          id="accountHolder"
          name="accountHolder"
          type="text"
          defaultValue={details?.accountHolder ?? ""}
          aria-invalid={!!state.fieldErrors?.accountHolder}
          required
        />
      </FormField>

      <FormField label="Account number / IBAN" htmlFor="accountNumber" required error={state.fieldErrors?.accountNumber}>
        <Input
          id="accountNumber"
          name="accountNumber"
          type="text"
          autoComplete="off"
          defaultValue={details?.accountNumber ?? ""}
          aria-invalid={!!state.fieldErrors?.accountNumber}
          required
        />
      </FormField>

      <FormField label="SWIFT / BIC" htmlFor="swiftBic" required error={state.fieldErrors?.swiftBic}>
        <Input
          id="swiftBic"
          name="swiftBic"
          type="text"
          defaultValue={details?.swiftBic ?? ""}
          aria-invalid={!!state.fieldErrors?.swiftBic}
          required
        />
      </FormField>

      <FormField label="Payment instructions" htmlFor="paymentInstructions" error={state.fieldErrors?.paymentInstructions}>
        <textarea
          id="paymentInstructions"
          name="paymentInstructions"
          rows={3}
          defaultValue={details?.paymentInstructions ?? ""}
          className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-black focus:ring-1 focus:ring-black focus:outline-none"
          placeholder="Any additional notes a client should know when paying you."
        />
      </FormField>

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
        {pending ? "Saving…" : "Save payment details"}
      </Button>
    </form>
  );
}
