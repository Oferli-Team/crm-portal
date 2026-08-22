"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormLabel } from "@/components/ui/form-field";
import type { AuthActionState } from "@/types";

const initialState: AuthActionState = { error: null };

/**
 * Sale-Ready Phase B, PR1 (Password Recovery). Shared by both
 * (auth)/forgot-password and portal/forgot-password — requestPasswordResetCore
 * (src/lib/auth/password-reset.ts) returns the identical generic message
 * either way, so the only things that differ between the two call sites
 * are which Server Action to submit to and where "Back to sign in" should
 * land, both passed in as props — see ResetPasswordForm's own doc comment
 * for the same reasoning applied there.
 */
export function ForgotPasswordForm({
  action,
  loginPath,
}: {
  action: (prevState: AuthActionState, formData: FormData) => Promise<AuthActionState>;
  loginPath: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);

  if (!pending && state.error === null && state.message) {
    return (
      <div className="space-y-4 text-center">
        <h2 className="text-base font-semibold text-gray-900">Check your email</h2>
        <p className="text-sm text-gray-600">{state.message}</p>
        <p className="text-sm text-gray-600">
          <Link
            href={loginPath}
            className="rounded font-medium text-black hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
          >
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <p className="text-sm text-gray-600">Enter your email and we&apos;ll send you a link to reset your password.</p>

      <div>
        <FormLabel htmlFor="email" required>
          Email
        </FormLabel>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>

      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}

      <Button type="submit" loading={pending} className="w-full">
        {pending ? "Sending…" : "Send reset link"}
      </Button>

      <p className="text-center text-sm text-gray-600">
        Remembered your password?{" "}
        <Link
          href={loginPath}
          className="rounded font-medium text-black hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
        >
          Sign in
        </Link>
      </p>
    </form>
  );
}
