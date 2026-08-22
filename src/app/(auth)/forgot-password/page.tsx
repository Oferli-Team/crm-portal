import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AuthCard } from "@/components/auth/auth-card";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { requestPasswordReset } from "./actions";

export default async function ForgotPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect("/dashboard");
  }

  return (
    <AuthCard>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight text-gray-900">Forgot your password?</h1>
      <ForgotPasswordForm action={requestPasswordReset} loginPath="/login" />
    </AuthCard>
  );
}
