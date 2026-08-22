import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { getOptionalPortalUser } from "@/lib/current-portal-user";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { requestPortalPasswordReset } from "./actions";

export default async function PortalForgotPasswordPage() {
  const identity = await getOptionalPortalUser();
  if (identity) {
    redirect("/portal");
  }

  // Already authenticated, but as staff rather than a portal contact —
  // same reasoning as portal/login/page.tsx's own check.
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (authUser) {
    const hasMembership = await prisma.membership.findFirst({
      where: { userId: authUser.id },
      select: { id: true },
    });
    if (hasMembership) {
      redirect("/dashboard");
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight text-gray-900">Forgot your password?</h1>
        <ForgotPasswordForm action={requestPortalPasswordReset} loginPath="/portal/login" />
      </div>
    </main>
  );
}
