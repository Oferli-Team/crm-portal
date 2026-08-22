"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { FormField } from "@/components/ui/form-field";
import { formatStatusLabel } from "@/lib/format";
import { INVITABLE_ROLES } from "@/lib/validation/invitation";
import { CopyLinkButton } from "./copy-link-button";
import type { InvitationFormState } from "@/types";

const initialState: InvitationFormState = { error: null };

export function InviteForm({
  action,
}: {
  action: (
    prevState: InvitationFormState,
    formData: FormData,
  ) => Promise<InvitationFormState>;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <FormField
        label="Email"
        htmlFor="email"
        required
        error={state.fieldErrors?.email}
      >
        <Input
          id="email"
          name="email"
          type="email"
          required
          aria-invalid={!!state.fieldErrors?.email}
          aria-describedby={state.fieldErrors?.email ? "email-error" : undefined}
        />
      </FormField>

      <FormField label="Role" htmlFor="role" required error={state.fieldErrors?.role}>
        <Select
          id="role"
          name="role"
          defaultValue="MEMBER"
          aria-invalid={!!state.fieldErrors?.role}
          aria-describedby={state.fieldErrors?.role ? "role-error" : undefined}
        >
          {INVITABLE_ROLES.map((role) => (
            <option key={role} value={role}>
              {formatStatusLabel(role)}
            </option>
          ))}
        </Select>
      </FormField>

      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}

      {state.token && (
        <div
          className={`rounded-md border p-3 ${
            state.emailFailed
              ? "border-amber-200 bg-amber-50"
              : "border-green-200 bg-green-50"
          }`}
        >
          <p
            role="status"
            className={`text-sm font-medium ${
              state.emailFailed ? "text-amber-800" : "text-green-800"
            }`}
          >
            {state.message ?? "Invitation created."}
          </p>
          <div className="mt-2">
            <CopyLinkButton token={state.token} />
          </div>
        </div>
      )}

      <div className="flex gap-3 pt-2">
        <Button type="submit" loading={pending}>
          {pending ? "Sending invitation…" : "Send invite"}
        </Button>
      </div>
    </form>
  );
}
