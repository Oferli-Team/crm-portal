"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { withToast } from "@/lib/toast-url";
import { createActivity } from "@/lib/activity/create-activity";
import { deliverNotificationEmails } from "@/lib/notifications/email/deliver-notification-email";
import { buildPortalInvitationAcceptedMetadata } from "@/lib/activity/portal-metadata";
import { checkRateLimit, getRequestIp, ACCEPT_PORTAL_INVITE_LIMIT } from "@/lib/rate-limit";
import type { InviteAcceptState } from "@/types";

const GENERIC_UNAVAILABLE_ERROR = "This invitation is no longer available.";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Derives a display name for a brand-new PortalUser from whatever Supabase
 * auth metadata is already available — never a separate form field, since
 * accepting an invitation has no "name" input of its own. Falls back to the
 * email's local part rather than leaving the name empty.
 */
function resolvePortalUserName(
  authUser: { user_metadata?: Record<string, unknown> | null },
  normalizedEmail: string,
): string {
  const metaName = authUser.user_metadata?.name;
  if (typeof metaName === "string" && metaName.trim()) return metaName.trim();

  const metaFullName = authUser.user_metadata?.full_name;
  if (typeof metaFullName === "string" && metaFullName.trim()) return metaFullName.trim();

  const localPart = normalizedEmail.split("@")[0];
  return localPart || normalizedEmail;
}

/**
 * If the current auth user already has a PortalUser row for this exact
 * Client, finishes the accept flow without any further mutation — used
 * both for a plain double-click and for the rarer case where a concurrent
 * request already completed the accept transaction by the time this one
 * re-checks. Never returns when it redirects.
 */
async function redirectIfAlreadyAccepted(authUserId: string, clientId: string): Promise<void> {
  const portalUser = await prisma.portalUser.findUnique({ where: { id: authUserId } });

  if (portalUser && portalUser.clientId === clientId) {
    revalidatePath("/portal");
    redirect(withToast("/portal", "Signed in to the client portal"));
  }
}

export async function acceptClientInvitationAction(token: string): Promise<InviteAcceptState> {
  const ip = await getRequestIp();
  const limitCheck = checkRateLimit(ACCEPT_PORTAL_INVITE_LIMIT, ip);
  if (limitCheck.limited) {
    return { error: limitCheck.message };
  }

  // The Supabase auth user is read directly — never via getOrCreateUser(),
  // which would create a staff User row. Accepting a Client Portal
  // invitation must never create (or touch) a User, Organization, or
  // Membership.
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) {
    return { error: GENERIC_UNAVAILABLE_ERROR };
  }

  // The token is the sole authorization boundary here — never scoped by
  // any organizationId/clientId the caller might supply.
  const invitation = await prisma.clientInvitation.findUnique({
    where: { token },
    include: { client: { select: { name: true, organizationId: true } } },
  });

  if (!invitation) {
    return { error: "Invitation not found or no longer available." };
  }

  if (invitation.status === "ACCEPTED") {
    // Idempotent re-click / duplicate tab: if it's already this identity's
    // PortalUser, finish quietly instead of erroring.
    await redirectIfAlreadyAccepted(authUser.id, invitation.clientId);
    return { error: GENERIC_UNAVAILABLE_ERROR };
  }

  if (invitation.status !== "PENDING") {
    // REVOKED, or a status this stage never produces.
    return { error: GENERIC_UNAVAILABLE_ERROR };
  }

  if (invitation.expiresAt.getTime() <= Date.now()) {
    return { error: "This invitation has expired." };
  }

  const organizationId = invitation.client.organizationId;
  if (!organizationId) {
    // A Client with no organization can't be safely scoped — refuse rather
    // than guess, same rule current-portal-user.ts already enforces.
    return { error: GENERIC_UNAVAILABLE_ERROR };
  }

  const normalizedUserEmail = normalizeEmail(authUser.email ?? "");
  const normalizedInviteEmail = normalizeEmail(invitation.email);
  if (normalizedUserEmail !== normalizedInviteEmail) {
    return { error: "This invitation was sent to a different email address." };
  }

  const portalUserName = resolvePortalUserName(authUser, normalizedUserEmail);

  // Portal Analytics persistence foundation (docs/analytics-architecture.md
  // §12, Slice 1). Server-owned, computed here rather than accepted as a
  // parameter on this public Server Action — a genuine PENDING -> ACCEPTED
  // transition (verified below by the transaction's own conditional
  // updateMany) is treated as this identity's first active portal
  // session. Reused for both the upsert's create and update branches, so
  // a single, consistent instant describes "when this acceptance
  // happened," not two slightly different ones.
  const acceptedAt = new Date();

  let notificationIds: string[];
  try {
    notificationIds = await prisma.$transaction(async (tx) => {
      // A conditional updateMany (not a plain findFirst-then-update) so two
      // concurrent accepts of the same token can't both "win": only the
      // first to commit finds status still PENDING and flips it; a second,
      // truly concurrent request finds zero matching rows and aborts
      // (handled below via STALE_INVITATION), instead of both proceeding
      // to create a duplicate PortalUser/Activity pair.
      const result = await tx.clientInvitation.updateMany({
        where: { id: invitation.id, status: "PENDING", expiresAt: { gt: new Date() } },
        data: { status: "ACCEPTED" },
      });
      if (result.count === 0) {
        throw new Error("STALE_INVITATION");
      }

      // Refuse to silently reassign an auth id that's already a PortalUser
      // for a *different* Client — the MVP model is exactly one PortalUser
      // per identity, and reassigning would silently transfer that
      // person's portal access to the wrong client.
      const existingPortalUser = await tx.portalUser.findUnique({
        where: { id: authUser.id },
      });
      if (existingPortalUser && existingPortalUser.clientId !== invitation.clientId) {
        throw new Error("CONFLICTING_PORTAL_USER");
      }

      // upsert, not create: id is the primary key, so Postgres resolves
      // this as a native INSERT ... ON CONFLICT DO UPDATE — a genuinely
      // concurrent second accept for the same identity/client simply
      // confirms the row the winner already created, rather than throwing.
      // Reaching this line at all already proves a genuine PENDING ->
      // ACCEPTED transition just happened (the updateMany above throws
      // STALE_INVITATION otherwise) — so both branches below are a real
      // active portal session, including the update branch: a PortalUser
      // with this exact id can legally already exist for this exact
      // Client (e.g. an earlier acceptance under a since-changed email,
      // now accepting a fresh invitation sent to the new address) without
      // that being a repeated/idempotent acceptance — the
      // redirectIfAlreadyAccepted()/STALE_INVITATION paths above already
      // handle every case where this transition did NOT genuinely happen,
      // and neither of those paths ever reaches this upsert. clientId is
      // never reassigned and email/name are never touched on the update
      // branch — only lastLoginAt is added here.
      const portalUser = await tx.portalUser.upsert({
        where: { id: authUser.id },
        create: {
          id: authUser.id,
          clientId: invitation.clientId,
          email: normalizedUserEmail,
          name: portalUserName,
          lastLoginAt: acceptedAt,
        },
        update: {
          lastLoginAt: acceptedAt,
        },
      });

      // Only reached on a genuine first-time PENDING -> ACCEPTED
      // transition (the updateMany above throws STALE_INVITATION
      // otherwise), so a duplicate/concurrent accept never logs a second
      // event here. actorId is always null: Activity.actor is a relation
      // to the staff User model, and a PortalUser is never a valid actor
      // there — portalUserName doubles as the display name via
      // formatActivity's metadata.actorName fallback.
      const activity = await createActivity(tx, {
        organizationId,
        actorId: null,
        entityType: "PORTAL_USER",
        entityId: portalUser.id,
        action: "PORTAL_INVITATION_ACCEPTED",
        metadata: buildPortalInvitationAcceptedMetadata(
          portalUser,
          invitation.client.name,
          portalUser.name,
        ),
        notificationContext: { invitedById: invitation.invitedById },
      });

      return activity.notificationIds;
    });
  } catch (err) {
    if (err instanceof Error && err.message === "STALE_INVITATION") {
      // Most likely a concurrent duplicate submit that already succeeded
      // under someone else's transaction — finish quietly if so.
      await redirectIfAlreadyAccepted(authUser.id, invitation.clientId);
      return { error: GENERIC_UNAVAILABLE_ERROR };
    }
    if (err instanceof Error && err.message === "CONFLICTING_PORTAL_USER") {
      return { error: GENERIC_UNAVAILABLE_ERROR };
    }
    throw err;
  }

  // Post-commit, best-effort — see deliverNotificationEmails's own header.
  await deliverNotificationEmails(notificationIds);

  revalidatePath("/portal");

  redirect(withToast("/portal", "Signed in to the client portal"));
}

export async function signOutForPortalInviteAction(token: string): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect(`/portal/login?redirectTo=${encodeURIComponent(`/portal/invite/${token}`)}`);
}
