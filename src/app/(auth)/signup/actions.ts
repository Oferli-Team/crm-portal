"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getOrCreateUser, getOrCreateOrganizationId } from "@/lib/current-user";
import { withToast } from "@/lib/toast-url";
import { sanitizeRedirectPath } from "@/lib/safe-redirect";
import { checkRateLimit, getRequestIp, SIGNUP_LIMIT } from "@/lib/rate-limit";
import type { AuthActionState } from "@/types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

export async function signup(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const ip = await getRequestIp();
  const limitCheck = checkRateLimit(SIGNUP_LIMIT, ip);
  if (limitCheck.limited) {
    return { error: limitCheck.message };
  }

  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");
  const organizationName = String(formData.get("organizationName") ?? "").trim();
  const redirectTo = sanitizeRedirectPath(String(formData.get("redirectTo") ?? ""));

  if (!email || !password || !confirmPassword || !organizationName) {
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
  // organizationName also travels as user_metadata: if Supabase requires
  // email confirmation (no session below), this is the only place it's
  // preserved until the user actually confirms and the *existing* lazy
  // getOrCreateOrganizationId() path (unchanged, called from
  // (dashboard)/layout.tsx on their first real visit) provisions their
  // organization — this app never creates business data for an identity
  // that isn't a real authenticated session yet (see getOrCreateUser()'s
  // own doc comment), so eager creation only happens in the branch below.
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { organizationName } },
  });

  if (error) {
    return { error: error.message };
  }

  if (data.session) {
    // A real session exists immediately (email confirmation disabled/not
    // required for this project) — provision the tenant synchronously,
    // through the exact same service-layer functions the rest of the app
    // already relies on (getOrCreateUser, getOrCreateOrganizationId), so
    // Organization + OWNER Membership + trial Subscription all exist
    // before the redirect. Onboarding needs no separate row: its progress
    // is always computed live from real data (docs/onboarding-
    // architecture.md), so a fresh Membership already renders the full
    // checklist at 0% the moment /dashboard loads.
    const user = await getOrCreateUser();
    await getOrCreateOrganizationId(user, organizationName);
    redirect(withToast(redirectTo, "Account created"));
  }

  return {
    error: null,
    message: "Account created. Check your email to confirm before signing in.",
  };
}
