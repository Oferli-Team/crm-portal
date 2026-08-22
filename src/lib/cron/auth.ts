import "server-only";
import { NextResponse } from "next/server";

/**
 * Gate for every /api/cron/* Route Handler — reads process.env.CRON_SECRET
 * (a server-only secret, never NEXT_PUBLIC_) and requires it verbatim as
 * `Authorization: Bearer <secret>`. Never reads a query string or any other
 * header, and never logs the secret or the caller's header value.
 *
 * Deliberately fails closed: if CRON_SECRET itself is unset (a deployment
 * that forgot to configure it), every call is rejected — there is no
 * "open" fallback state. The same generic 401 covers every failure reason
 * (missing header, malformed, wrong secret, unset env) so a caller can
 * never distinguish "you got the secret wrong" from "this deployment isn't
 * configured for cron at all."
 *
 * No TEST_MODE bypass exists here on purpose — unlike the identity/Storage
 * test-mode swaps elsewhere in this app, weakening auth itself would be a
 * second, weaker code path. Tests instead set a real (test-only) CRON_SECRET
 * value in their own environment and authenticate through this exact same
 * check, the same way E2E already sets a placeholder INVITATION_FROM_EMAIL
 * rather than bypassing email delivery's own logic.
 */
export function requireCronAuth(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization");

  if (!secret || header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
