import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyRecoveryToken, testModeRecoveryCookie } from "@/lib/auth/recovery-token";

/**
 * Sale-Ready Phase B, PR1 (Password Recovery). The one link every
 * password-reset email points at (see src/lib/email/password-reset.ts) —
 * shared by both staff and portal, rather than two near-identical routes,
 * since the only thing that differs between them is which page to land on
 * afterward.
 *
 * `audience` is only ever a pre-verification default for the invalid/
 * expired fallback below — never trusted for anything past that. Once a
 * token verifies, the destination is re-derived authoritatively from the
 * now-confirmed identity's own User/PortalUser row, exactly like every
 * other staff-vs-portal resolution in this app already works (see
 * portalLogin's own Membership fallback in src/app/portal/login/
 * actions.ts). A manipulated `audience` value can therefore never do
 * anything worse than pick the wrong (but still legitimate, in-app)
 * landing page before verification fails outright — this route has no
 * open-redirect surface at all, by construction, not by validation.
 */
const DESTINATIONS = {
  staff: "/reset-password",
  portal: "/portal/reset-password",
} as const;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get("token_hash");
  const audienceHint = url.searchParams.get("audience") === "portal" ? "portal" : "staff";
  const fallback = DESTINATIONS[audienceHint];

  if (!tokenHash) {
    return NextResponse.redirect(new URL(`${fallback}?invalid=1`, url.origin));
  }

  const verified = await verifyRecoveryToken(tokenHash);
  if (!verified.ok) {
    return NextResponse.redirect(new URL(`${fallback}?invalid=1`, url.origin));
  }

  const [staffUser, portalUser] = await Promise.all([
    prisma.user.findUnique({ where: { email: verified.email }, select: { id: true } }),
    prisma.portalUser.findFirst({ where: { email: verified.email }, select: { id: true } }),
  ]);

  const isPortal = Boolean(portalUser) && !staffUser;
  const destination = isPortal ? DESTINATIONS.portal : DESTINATIONS.staff;
  const localId = isPortal ? portalUser?.id : staffUser?.id;

  const response = NextResponse.redirect(new URL(destination, url.origin));

  // null outside TEST_MODE — a real verifyOtp() call inside
  // verifyRecoveryToken() already established the real session as a side
  // effect. In TEST_MODE, this is what actually logs the identity in; set
  // directly on this exact response object, not via next/headers'
  // cookies() — see testModeRecoveryCookie's own doc comment for why.
  const cookie = localId ? testModeRecoveryCookie({ id: localId, email: verified.email }) : null;
  if (cookie) {
    response.cookies.set(cookie.name, cookie.value, cookie.options);
  }

  return response;
}
