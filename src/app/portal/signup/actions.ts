"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { withToast } from "@/lib/toast-url";
import { sanitizePortalRedirectPath } from "@/lib/safe-redirect";
import { checkRateLimit, getRequestIp, PORTAL_SIGNUP_LIMIT } from "@/lib/rate-limit";
import type { AuthActionState } from "@/types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

/**
 * Deliberately separate from (auth)/signup/actions.ts's `signup`, even
 * though the Supabase call itself is identical: this one sanitizes
 * redirectTo against /portal only (never /dashboard), and its default
 * landing page is /portal — keeping the two apart means a future change to
 * either trust boundary can never leak into the other by accident.
 *
 * Like the staff signup action, this never creates a Prisma User,
 * Organization, or Membership row itself — it only calls Supabase's
 * signUp. A PortalUser is only ever created by acceptClientInvitationAction,
 * once the new account accepts a specific ClientInvitation.
 */
export async function portalSignup(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const ip = await getRequestIp();
  const limitCheck = checkRateLimit(PORTAL_SIGNUP_LIMIT, ip);
  if (limitCheck.limited) {
    return { error: limitCheck.message };
  }

  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");
  const redirectTo = sanitizePortalRedirectPath(String(formData.get("redirectTo") ?? ""));

  if (!email || !password || !confirmPassword) {
    return { error: "All fields are required." };
  }

  if (!EMAIL_PATTERN.test(email)) {
    return { error: "Enter a valid email address." };
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }

  if (password !== confirmPassword) {
    return { error: "Passwords do not match." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({ email, password });

  if (error) {
    return { error: error.message };
  }

  if (data.session) {
    redirect(withToast(redirectTo, "Account created"));
  }

  return {
    error: null,
    message: "Account created. Check your email to confirm before signing in.",
  };
}
