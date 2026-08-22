import Link from "next/link";
import { getVerifiedAuthUser } from "@/lib/supabase/server";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { resetPortalPassword, signOutAndGoToPortalLogin } from "./actions";

/**
 * Sale-Ready Phase B, PR1 (Password Recovery). Portal counterpart of
 * (auth)/reset-password/page.tsx — same session-presence check, same
 * "no session at all" friendly fallback. See that page's own doc comment.
 */
export default async function PortalResetPasswordPage() {
  const user = await getVerifiedAuthUser();

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-8 shadow-sm">
        {user ? (
          <>
            <h1 className="mb-6 text-2xl font-semibold tracking-tight text-gray-900">Set a new password</h1>
            <ResetPasswordForm action={resetPortalPassword} signOutAction={signOutAndGoToPortalLogin} />
          </>
        ) : (
          <div className="space-y-4 text-center">
            <h1 className="text-2xl font-semibold tracking-tight text-gray-900">This link is invalid or has expired</h1>
            <p className="text-sm text-gray-600">Request a new password reset link to continue.</p>
            <p className="text-sm text-gray-600">
              <Link
                href="/portal/forgot-password"
                className="rounded font-medium text-black hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
              >
                Request a new link
              </Link>
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
