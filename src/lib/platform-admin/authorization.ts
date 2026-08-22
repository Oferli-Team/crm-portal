import { redirect } from "next/navigation";
import { getVerifiedAuthUser } from "@/lib/supabase/server";

/**
 * Sale-Ready Phase C. Platform Admin identity is deliberately NOT a
 * `Role` enum value and NOT a `Membership` row — it has to live outside
 * the Organization/Membership graph entirely, the same reasoning
 * `PortalUser` already uses to stay structurally separate from `User`
 * (see the Phase C architecture review). `Membership.role === "OWNER"`
 * means "owns this one customer's workspace"; it says nothing about who
 * operates the SaaS itself, and conflating the two would mean any
 * customer who owns their own org could, in principle, be granted
 * platform authority by the same mechanism — exactly the conflation this
 * module exists to avoid.
 *
 * A comma-separated env var allowlist, not a database table: matches the
 * `src/lib/legal/platform-config.ts` precedent (operator-level facts live
 * in env vars, not the database) exactly, needs no migration, and means
 * changing who holds this power requires a reviewable deploy — a feature,
 * not a limitation, for something this sensitive on a pre-revenue,
 * single-operator product. Revisit as a real table once there's more than
 * one person who should ever have this.
 */
function parseAdminEmails(): Set<string> {
  const raw = process.env.PLATFORM_ADMIN_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isPlatformAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return parseAdminEmails().has(email.trim().toLowerCase());
}

/**
 * The sole entry point every page under `(platform-admin)` calls, in its
 * layout, before anything else runs — same "guard lives in the layout,
 * not repeated per-page" pattern `(dashboard)/layout.tsx` already
 * establishes for its own portal-identity guard.
 *
 * Deliberately never calls getCurrentUserOrganization()/getCurrentMembership()
 * — this has no concept of "active organization" at all, and must not
 * gain one; Platform Admin's entire purpose is to read across every
 * organization, which is exactly what those two functions exist to
 * prevent everywhere else in this app.
 *
 * Redirects rather than throwing a visible "access denied" — mirroring
 * (dashboard)/layout.tsx's own silent-redirect discipline for the portal-
 * identity guard, so this route's existence is never confirmed to anyone
 * who isn't already on the allowlist. An authenticated non-admin lands
 * back on their own /dashboard, not on a page that tells them what they
 * were denied.
 */
export async function requirePlatformAdmin(): Promise<{ email: string }> {
  const user = await getVerifiedAuthUser();

  if (!user) {
    redirect("/login");
  }

  if (!isPlatformAdmin(user.email)) {
    redirect("/dashboard");
  }

  return { email: user.email! };
}
