import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { generateRecoveryToken, type GenerateRecoveryTokenResult } from "@/lib/auth/recovery-token";
import { sendPasswordResetEmail, type PasswordResetAudience } from "@/lib/email/password-reset";
import type { SendEmailFn } from "@/lib/email/resend-client";
import type { AuthActionState } from "@/types";

/**
 * Sale-Ready Phase B, PR1 (Password Recovery). Identical shape to
 * validation/company-profile.ts's own MIN_PASSWORD_LENGTH... except that
 * one doesn't exist; this mirrors src/app/(auth)/signup/actions.ts's own
 * inline MIN_PASSWORD_LENGTH = 8 exactly (the required "identical to
 * signup" policy), duplicated here rather than imported — same
 * established convention as EMAIL_PATTERN's own multi-file duplication.
 */
const MIN_PASSWORD_LENGTH = 8;

/**
 * The one message every forgot-password request ever returns, regardless
 * of whether the email matched a real account — the whole point of this
 * function's own "never let the two branches diverge" structure below.
 */
const GENERIC_REQUEST_MESSAGE = "If an account exists for that email, we've sent a password reset link.";

export type RequestPasswordResetParams = {
  email: string;
  audience: PasswordResetAudience;
};

/**
 * OWNER of the enumeration-prevention guarantee: looks up the email
 * against this app's own User/PortalUser table (never Supabase Auth
 * directly — a Prisma miss and a real "user not found" from Supabase's
 * own admin API would otherwise behave identically anyway, but resolving
 * identity type — staff vs portal — first is also how every other
 * cross-audience check in this app already works, e.g. portalLogin's own
 * Membership fallback). No matter which branch below runs, the exact same
 * AuthActionState is returned — never a different error, never a
 * different timing-observable code path beyond what an email provider
 * network call itself already costs.
 *
 * `deps.generateToken` mirrors `deps.sendEmail` — both default to the
 * real implementation; integration tests inject fakes for either (or
 * both) to assert on the "known email → a token was generated → an email
 * was sent" chain deterministically, without a real Supabase admin client
 * configured (see that test file's own doc comment for why generateToken
 * specifically needs this seam, unlike most of this app's other
 * TEST_MODE-branched functions).
 */
export async function requestPasswordResetCore(
  params: RequestPasswordResetParams,
  deps: { sendEmail?: SendEmailFn; generateToken?: (email: string) => Promise<GenerateRecoveryTokenResult> } = {},
): Promise<AuthActionState> {
  const email = params.email.trim();
  const generateToken = deps.generateToken ?? generateRecoveryToken;

  const identity =
    params.audience === "portal"
      ? await prisma.portalUser.findFirst({ where: { email }, select: { id: true } })
      : await prisma.user.findUnique({ where: { email }, select: { id: true } });

  if (identity) {
    const token = await generateToken(email);
    if (token.ok) {
      await sendPasswordResetEmail({ to: email, tokenHash: token.tokenHash, audience: params.audience }, deps);
    }
  }

  return { error: null, message: GENERIC_REQUEST_MESSAGE };
}

export type ResetPasswordParams = {
  newPassword: string;
  confirmPassword: string;
};

const NO_SESSION_ERROR = "This link is invalid or has expired. Request a new one to continue.";

/**
 * Identity-agnostic — updateUser() operates on whichever session the
 * current request's cookies resolve to, staff or portal alike, so this
 * needs no audience parameter at all (unlike requestPasswordResetCore,
 * which does, because it has to pick a Prisma table).
 *
 * Deliberately does NOT sign the session out here, even though the
 * recovery session must not outlive this flow — see signOutAfterReset()
 * below for where that actually happens and why. Next.js automatically
 * re-renders the current route's Server Components after a Server Action
 * resolves (to reflect any server-side change), which — verified
 * empirically — happens before this function's own caller ever gets to
 * render "Password updated" client-side: signing out here made the
 * page's own session check (ResetPasswordPage's getVerifiedAuthUser())
 * flip to "no session" on that same implicit refresh, silently replacing
 * the success screen with the "invalid or expired" fallback instead. The
 * fix is ordering, not architecture: keep the recovery session alive
 * through the success screen itself, and only end it when the user
 * actually asks to move on (their own "Continue to sign in" click).
 */
export async function resetPasswordCore(params: ResetPasswordParams): Promise<AuthActionState> {
  const { newPassword, confirmPassword } = params;

  if (!newPassword || !confirmPassword) {
    return { error: "Both fields are required." };
  }

  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }

  if (newPassword !== confirmPassword) {
    return { error: "Passwords do not match." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: NO_SESSION_ERROR };
  }

  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) {
    return { error: "We couldn't update your password. Request a new reset link and try again." };
  }

  return { error: null, message: "Password updated." };
}

/**
 * Ends the recovery session, deliberately kept alive through
 * resetPasswordCore() itself (see that function's own doc comment) —
 * called only when the user clicks "Continue to sign in" on the success
 * screen, the real end of this flow. Identity-agnostic, same reasoning as
 * resetPasswordCore.
 */
export async function signOutCore(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
}
