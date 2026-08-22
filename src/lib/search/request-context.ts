import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import type { Role } from "@/generated/prisma/enums";

/**
 * Global Search Stage 2 (docs/search-architecture.md §6, and this stage's
 * own explicit API auth contract). `/api/search` is a JSON API, not a page
 * — it must never behave like one. Every existing identity helper in this
 * app (`getOrCreateUser`, `getCurrentUserOrganization`, `getCurrentMembership`,
 * `getCurrentPortalUser`) either `redirect()`s (an HTML 3xx response a
 * `fetch()` caller can't meaningfully act on) or auto-provisions a brand
 * new User/Organization/Membership on first contact — both are wrong for
 * an API route a browser's own JS calls directly. This module is the
 * dedicated, redirect-free, non-provisioning replacement, built directly on
 * the same primitives (`createClient()`, `cookies()`, Prisma) those helpers
 * use internally, never on the helpers themselves.
 *
 * Resolution order, matching the contract's own explicit cases:
 *   1. No Supabase session at all                          -> 401
 *   2. A session, but no staff User row for it              -> checked against PortalUser next
 *   2a. ...and a PortalUser row exists                       -> 403 (Client Portal identity)
 *   2b. ...and neither a User nor a PortalUser row exists     -> 403 (unknown identity)
 *   3. A session with a staff User row (even if a PortalUser
 *      row *also* exists for the same id — checked first,
 *      staff wins)                                          -> resolve organizationId
 *   3a. ...but no Membership can be resolved at all           -> 403 (no organization to search)
 *   3b. ...and a Membership resolves                          -> ok, with { userId, organizationId, role }
 */

const ACTIVE_ORG_COOKIE = "active_organization_id";

export type SearchRequestContext =
  | { ok: true; userId: string; organizationId: string; role: Role }
  | { ok: false; status: 401 | 403 };

/**
 * Read-only mirror of current-user.ts's `resolveActiveOrganizationId` —
 * same cookie-then-OWNER-Membership fallback order — but returns `null`
 * instead of ever calling `getOrCreateOrganizationId()`. An API route must
 * never auto-provision an Organization/Membership as a side effect of a
 * search keystroke; a user who has genuinely never visited any real page
 * yet (and so has no Membership at all) gets refused here, not silently
 * enrolled into a brand-new personal workspace.
 */
async function resolveOrganizationMembership(
  userId: string,
): Promise<{ organizationId: string; role: Role } | null> {
  const cookieStore = await cookies();
  const requestedOrganizationId = cookieStore.get(ACTIVE_ORG_COOKIE)?.value;

  if (requestedOrganizationId) {
    const membership = await prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId: requestedOrganizationId } },
      select: { organizationId: true, role: true },
    });
    if (membership) return membership;
  }

  const ownerMembership = await prisma.membership.findFirst({
    where: { userId, role: "OWNER" },
    select: { organizationId: true, role: true },
  });
  if (ownerMembership) return ownerMembership;

  const anyMembership = await prisma.membership.findFirst({
    where: { userId },
    select: { organizationId: true, role: true },
    orderBy: { createdAt: "asc" },
  });
  return anyMembership;
}

export async function getSearchRequestContext(): Promise<SearchRequestContext> {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) {
    return { ok: false, status: 401 };
  }

  // Staff wins over a co-existing PortalUser row for the same id (the
  // contract's own "dual identity with valid staff User -> allowed as
  // staff" case) — check User first, unconditionally.
  const user = await prisma.user.findUnique({ where: { id: authUser.id }, select: { id: true } });

  if (!user) {
    // Both "a real Client Portal identity" and "an authenticated session
    // with neither a User nor a PortalUser row at all" return this exact
    // same 403 — the contract never distinguishes them in the response
    // (matching this app's own "foreign-org vs. nonexistent" discipline
    // elsewhere: never leak which case actually occurred), so there is no
    // need to spend a second query telling them apart here either.
    return { ok: false, status: 403 };
  }

  const membership = await resolveOrganizationMembership(user.id);
  if (!membership) {
    return { ok: false, status: 403 };
  }

  return { ok: true, userId: user.id, organizationId: membership.organizationId, role: membership.role };
}
