import Link from "next/link";
import { getVerifiedAuthUser } from "@/lib/supabase/server";
import { AuthCard } from "@/components/auth/auth-card";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { resetPassword, signOutAndGoToLogin } from "./actions";

/**
 * Sale-Ready Phase B, PR1 (Password Recovery). Reached only via /auth/
 * confirm after a token verifies — a real Supabase session (or, in
 * TEST_MODE, the identity-cookie bypass) must already exist by the time
 * this renders. No session at all — expired token, invalid token, a
 * direct visit with no link ever clicked — all collapse to the exact same
 * friendly view; the difference is never surfaced, the same "don't leak
 * more than the generic outcome" reasoning the forgot-password request
 * itself already follows.
 */
export default async function ResetPasswordPage() {
  const user = await getVerifiedAuthUser();

  return (
    <AuthCard>
      {user ? (
        <>
          <h1 className="mb-6 text-2xl font-semibold tracking-tight text-gray-900">Set a new password</h1>
          <ResetPasswordForm action={resetPassword} signOutAction={signOutAndGoToLogin} />
        </>
      ) : (
        <div className="space-y-4 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">This link is invalid or has expired</h1>
          <p className="text-sm text-gray-600">Request a new password reset link to continue.</p>
          <p className="text-sm text-gray-600">
            <Link
              href="/forgot-password"
              className="rounded font-medium text-black hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
            >
              Request a new link
            </Link>
          </p>
        </div>
      )}
    </AuthCard>
  );
}
