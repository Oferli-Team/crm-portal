"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormLabel } from "@/components/ui/form-field";
import type { AuthActionState } from "@/types";

const initialState: AuthActionState = { error: null };

/**
 * Sale-Ready Phase B, PR1 (Password Recovery). Shared by both
 * (auth)/reset-password and portal/reset-password — resetPasswordCore
 * (src/lib/auth/password-reset.ts) is identity-agnostic, so the only
 * things that differ between the two call sites are which Server Action
 * to submit to and which one ends the recovery session and lands on the
 * right login page, both passed in as props rather than duplicating this
 * component. Same "swap the form for a dedicated success screen" shape as
 * ForgotPasswordForm/PortalForgotPasswordForm, matching
 * AttachmentUploadForm's own "accept the action as a prop" pattern for a
 * form reused across more than one parent.
 *
 * "Continue to sign in" is its own <form>/Server Action (signOutAction),
 * not a plain <Link> — see resetPasswordCore's own doc comment for why
 * ending the recovery session has to happen here, on the user's own next
 * action, rather than inside the reset itself.
 */
export function ResetPasswordForm({
  action,
  signOutAction,
}: {
  action: (prevState: AuthActionState, formData: FormData) => Promise<AuthActionState>;
  signOutAction: () => Promise<void>;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);

  if (!pending && state.error === null && state.message) {
    return (
      <div className="space-y-4 text-center">
        <h2 className="text-base font-semibold text-gray-900">Password updated</h2>
        <p className="text-sm text-gray-600">Sign in with your new password.</p>
        <form action={signOutAction}>
          <Button type="submit" className="w-full">
            Continue to sign in
          </Button>
        </form>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <p className="text-sm text-gray-600">Choose a new password for your account.</p>

      <div>
        <FormLabel htmlFor="password" required>
          New password
        </FormLabel>
        <Input id="password" name="password" type="password" autoComplete="new-password" required />
      </div>

      <div>
        <FormLabel htmlFor="confirmPassword" required>
          Confirm new password
        </FormLabel>
        <Input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" required />
      </div>

      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}

      <Button type="submit" loading={pending} className="w-full">
        {pending ? "Updating…" : "Update password"}
      </Button>
    </form>
  );
}
