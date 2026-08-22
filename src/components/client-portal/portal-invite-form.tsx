"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { PortalCopyLinkButton } from "./portal-copy-link-button";
import type { PortalInvitationFormState } from "@/types";

const initialState: PortalInvitationFormState = { error: null };

export function PortalInviteForm({
  action,
}: {
  action: (
    prevState: PortalInvitationFormState,
    formData: FormData,
  ) => Promise<PortalInvitationFormState>;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <FormField
        label="Email"
        htmlFor="portal-invite-email"
        required
        error={state.fieldErrors?.email}
      >
        <Input
          id="portal-invite-email"
          name="email"
          type="email"
          required
          aria-invalid={!!state.fieldErrors?.email}
          aria-describedby={state.fieldErrors?.email ? "portal-invite-email-error" : undefined}
        />
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
            <PortalCopyLinkButton token={state.token} />
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
