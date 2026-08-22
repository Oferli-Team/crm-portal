"use server";

import { requestPasswordResetCore } from "@/lib/auth/password-reset";
import { checkRateLimit, getRequestIp, PASSWORD_RESET_REQUEST_LIMIT } from "@/lib/rate-limit";
import type { AuthActionState } from "@/types";

/** Sale-Ready Phase B, PR1 (Password Recovery). Same "rate limit in the action, not the core" shape as login/signup — see requestPasswordResetCore's own doc comment for the enumeration guarantee. */
export async function requestPasswordReset(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const ip = await getRequestIp();
  const limitCheck = checkRateLimit(PASSWORD_RESET_REQUEST_LIMIT, ip);
  if (limitCheck.limited) {
    return { error: limitCheck.message };
  }

  const email = String(formData.get("email") ?? "").trim();
  if (!email) {
    return { error: "Enter your email address." };
  }

  return requestPasswordResetCore({ email, audience: "staff" });
}
