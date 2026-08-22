"use server";

import { redirect } from "next/navigation";
import { resetPasswordCore, signOutCore } from "@/lib/auth/password-reset";
import type { AuthActionState } from "@/types";

/** Sale-Ready Phase B, PR1 (Password Recovery). Thin wrapper — resetPasswordCore is identity-agnostic (see its own doc comment), so staff and portal share it verbatim. */
export async function resetPassword(_prevState: AuthActionState, formData: FormData): Promise<AuthActionState> {
  const newPassword = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  return resetPasswordCore({ newPassword, confirmPassword });
}

/** Ends the recovery session and lands on the real login page — see resetPasswordCore's own doc comment for why this is a separate action from the reset itself, not folded into it. */
export async function signOutAndGoToLogin(): Promise<void> {
  await signOutCore();
  redirect("/login");
}
