"use server";

import { redirect } from "next/navigation";
import { resetPasswordCore, signOutCore } from "@/lib/auth/password-reset";
import type { AuthActionState } from "@/types";

/** Sale-Ready Phase B, PR1 (Password Recovery). resetPasswordCore is identity-agnostic — see its own doc comment — so this is a verbatim thin wrapper, identical to (auth)/reset-password/actions.ts's own resetPassword. */
export async function resetPortalPassword(_prevState: AuthActionState, formData: FormData): Promise<AuthActionState> {
  const newPassword = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  return resetPasswordCore({ newPassword, confirmPassword });
}

/** Ends the recovery session and lands on the real portal login page — see (auth)/reset-password/actions.ts's own signOutAndGoToLogin for why this is separate from the reset itself. */
export async function signOutAndGoToPortalLogin(): Promise<void> {
  await signOutCore();
  redirect("/portal/login");
}
