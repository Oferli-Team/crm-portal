import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import type { PortalUser, Client } from "@/generated/prisma/client";
import type { User as SupabaseAuthUser } from "@supabase/supabase-js";

export type CurrentPortalUser = {
  authUser: SupabaseAuthUser;
  portalUser: PortalUser;
  client: Client;
  clientId: string;
  /** Client.organizationId, guaranteed non-null here — see getOptionalPortalUser(). */
  organizationId: string;
};

/**
 * Resolves the PortalUser row (if any) for the given Supabase auth user,
 * together with its Client. Returns null — never redirects — for every
 * failure case: no PortalUser row, or a PortalUser whose Client has no
 * organization (a Client with organizationId = null can't be safely scoped,
 * so access is refused rather than guessed at).
 */
async function resolvePortalIdentity(
  authUser: SupabaseAuthUser,
): Promise<CurrentPortalUser | null> {
  const portalUser = await prisma.portalUser.findUnique({
    where: { id: authUser.id },
    include: { client: true },
  });

  if (!portalUser || !portalUser.client.organizationId) {
    return null;
  }

  return {
    authUser,
    portalUser,
    client: portalUser.client,
    clientId: portalUser.clientId,
    organizationId: portalUser.client.organizationId,
  };
}

/**
 * Strict variant for use inside already-gated portal pages: resolves the
 * current Client Portal identity or redirects to /portal/login. Never
 * calls getOrCreateUser(), never creates a User, Organization, or
 * PortalUser — a PortalUser row (with a Client that has an organization)
 * must already exist, or this refuses access rather than provisioning
 * anything. organizationId/clientId are always derived from this lookup,
 * never accepted from a cookie or query string — there is no "active
 * organization" concept for a portal identity at all.
 */
export async function getCurrentPortalUser(): Promise<CurrentPortalUser> {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) {
    redirect("/portal/login");
  }

  const identity = await resolvePortalIdentity(authUser);
  if (!identity) {
    redirect("/portal/login");
  }

  return identity;
}

/**
 * Non-throwing variant for identity-routing decisions (layouts, the portal
 * login action): returns null if there's no Supabase session, no PortalUser
 * row for it, or that PortalUser's Client has no organization. Never
 * redirects, so callers can inspect "why" (e.g. distinguish "no session at
 * all" from "session belongs to staff, not a portal contact") and decide
 * where to send the caller themselves.
 */
export async function getOptionalPortalUser(): Promise<CurrentPortalUser | null> {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) {
    return null;
  }

  return resolvePortalIdentity(authUser);
}
