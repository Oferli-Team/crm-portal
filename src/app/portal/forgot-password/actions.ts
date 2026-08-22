"use server";

import { requestPasswordResetCore } from "@/lib/auth/password-reset";
import { checkRateLimit, getRequestIp, PORTAL_PASSWORD_RESET_REQUEST_LIMIT } from "@/lib/rate-limit";
import type { AuthActionState } from "@/types";

/** Sale-Ready Phase B, PR1 (Password Recovery). Portal counterpart of (auth)/forgot-password/actions.ts's requestPasswordReset — same shape, isolated rate-limit bucket, "portal" audience. */
export async function requestPortalPasswordReset(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const ip = await getRequestIp();
  const limitCheck = checkRateLimit(PORTAL_PASSWORD_RESET_REQUEST_LIMIT, ip);
  if (limitCheck.limited) {
    return { error: limitCheck.message };
  }

  const email = String(formData.get("email") ?? "").trim();
  if (!email) {
    return { error: "Enter your email address." };
  }

  return requestPasswordResetCore({ email, audience: "portal" });
}
