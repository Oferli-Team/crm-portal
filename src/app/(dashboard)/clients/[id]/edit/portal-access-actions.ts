"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { Prisma } from "@/generated/prisma/client";
import { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { getCurrentMembership } from "@/lib/current-user";
import { createActivity } from "@/lib/activity/create-activity";
import {
  buildPortalInvitationMetadata,
  buildPortalUserRemovedMetadata,
} from "@/lib/activity/portal-metadata";
import { sendClientPortalInvitationEmail } from "@/lib/email/client-portal-invitations";
import { checkRateLimit, INVITE_PORTAL_USER_LIMIT, RESEND_PORTAL_INVITE_LIMIT } from "@/lib/rate-limit";
import type { PortalInvitationFormState } from "@/types";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function canManagePortalAccess(role: Role): boolean {
  return role === Role.OWNER || role === Role.ADMIN;
}

export async function inviteClientPortalUserAction(
  clientId: string,
  _prevState: PortalInvitationFormState,
  formData: FormData,
): Promise<PortalInvitationFormState> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();

  if (!email) {
    return { error: null, fieldErrors: { email: "Email is required." } };
  }
  if (!EMAIL_PATTERN.test(email)) {
    return { error: null, fieldErrors: { email: "Enter a valid email address." } };
  }

  const { user, organizationId, membership } = await getCurrentMembership();

  // Server-side gate — the invite form is only ever rendered for
  // OWNER/ADMIN, but a request can be crafted directly, so re-check here.
  if (!canManagePortalAccess(membership.role)) {
    return { error: "You don't have permission to manage client portal access." };
  }

  const limitCheck = checkRateLimit(INVITE_PORTAL_USER_LIMIT, user.id);
  if (limitCheck.limited) {
    return { error: limitCheck.message };
  }

  // Scoped by id + organizationId together — a foreign org's client id
  // simply doesn't match, indistinguishable from a nonexistent one. A
  // Client with organizationId = null (pre-multi-tenant data) can't be
  // safely scoped either, so it's excluded by the same query rather than
  // checked separately afterwards.
  const client = await prisma.client.findFirst({
    where: { id: clientId, organizationId },
    select: { id: true, name: true },
  });

  if (!client) {
    return { error: "Client not found." };
  }

  const existingPortalUser = await prisma.portalUser.findFirst({
    where: { clientId: client.id, email },
    select: { id: true },
  });
  if (existingPortalUser) {
    return { error: null, fieldErrors: { email: "Already has portal access." } };
  }

  const token = randomUUID();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  try {
    // ClientInvitation upsert and its Activity row are one atomic unit —
    // re-inviting via this form always logs PORTAL_INVITATION_SENT, never
    // PORTAL_INVITATION_RESENT (that's resendClientInvitationAction's
    // event), even when the @@unique([clientId, email]) upsert lands on
    // the "update" branch because a previous invitation to this address
    // was revoked or expired.
    await prisma.$transaction(async (tx) => {
      const invitation = await tx.clientInvitation.upsert({
        where: { clientId_email: { clientId: client.id, email } },
        create: {
          clientId: client.id,
          email,
          token,
          status: "PENDING",
          expiresAt,
          invitedById: user.id,
        },
        update: {
          token,
          status: "PENDING",
          expiresAt,
          invitedById: user.id,
        },
      });

      await createActivity(tx, {
        organizationId,
        actorId: user.id,
        entityType: "PORTAL_USER",
        entityId: invitation.id,
        action: "PORTAL_INVITATION_SENT",
        metadata: buildPortalInvitationMetadata(invitation, client.name, user.name),
      });
    });
  } catch (err) {
    // Two concurrent invites for the same email can still race the
    // upsert's own read-then-write; ask the submitter to retry rather than
    // surface a raw constraint violation.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { error: "Could not create the invitation. Please try again." };
    }
    throw err;
  }

  revalidatePath(`/clients/${client.id}/edit`);

  // The ClientInvitation row and its Activity are already committed at
  // this point — an email provider failure below only affects delivery,
  // never rolls either of them back.
  const emailResult = await sendClientPortalInvitationEmail({
    to: email,
    clientName: client.name,
    invitedByName: user.name,
    invitationToken: token,
    expiresAt,
  });

  if (!emailResult.delivered) {
    return {
      error: null,
      message:
        "Invitation created, but the email could not be sent. Copy the invitation link manually.",
      token,
      emailFailed: true,
    };
  }

  return { error: null, message: "Invitation sent.", token };
}

export async function resendClientInvitationAction(
  invitationId: string,
): Promise<PortalInvitationFormState> {
  const { user, organizationId, membership } = await getCurrentMembership();

  if (!canManagePortalAccess(membership.role)) {
    return { error: "You don't have permission to manage client portal access." };
  }

  // Keyed by the invitation's own id, not the actor or IP — caps how many
  // times any one invitation's email can be re-sent, checked before the
  // lookup below so a rate-limited caller never touches the database.
  const limitCheck = checkRateLimit(RESEND_PORTAL_INVITE_LIMIT, invitationId);
  if (limitCheck.limited) {
    return { error: limitCheck.message };
  }

  // Scoped by id + client.organizationId together — a foreign org's
  // invitation id simply doesn't match, indistinguishable from a
  // nonexistent one.
  const invitation = await prisma.clientInvitation.findFirst({
    where: { id: invitationId, client: { organizationId } },
    select: {
      id: true,
      email: true,
      status: true,
      clientId: true,
      client: { select: { name: true } },
    },
  });

  if (!invitation) {
    return { error: "Invitation not found." };
  }

  if (invitation.status === "ACCEPTED") {
    return { error: "This invitation has already been accepted." };
  }

  // PENDING, EXPIRED, or REVOKED all get a fresh token/expiry and land
  // back in PENDING — the email is never touched by a resend. The old
  // token is invalidated by this same update, so only the new one below
  // is ever emailed out. The new token itself is never written into
  // Activity metadata.
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  // Update and its Activity row are one atomic unit.
  await prisma.$transaction(async (tx) => {
    await tx.clientInvitation.update({
      where: { id: invitation.id },
      data: {
        token,
        status: "PENDING",
        expiresAt,
        invitedById: user.id,
      },
    });

    await createActivity(tx, {
      organizationId,
      actorId: user.id,
      entityType: "PORTAL_USER",
      entityId: invitation.id,
      action: "PORTAL_INVITATION_RESENT",
      metadata: buildPortalInvitationMetadata(invitation, invitation.client.name, user.name),
    });
  });

  revalidatePath(`/clients/${invitation.clientId}/edit`);

  // ClientInvitation and its Activity are already committed regardless of
  // what happens next — a delivery failure here never reverts either of
  // them or regenerates the token a second time (this call is made
  // exactly once).
  const emailResult = await sendClientPortalInvitationEmail({
    to: invitation.email,
    clientName: invitation.client.name,
    invitedByName: user.name,
    invitationToken: token,
    expiresAt,
  });

  if (!emailResult.delivered) {
    return {
      error: null,
      message: "Invitation updated, but the email could not be sent.",
      token,
      emailFailed: true,
    };
  }

  return { error: null, message: "Invitation resent.", token };
}

export async function cancelClientInvitationAction(invitationId: string): Promise<void> {
  const { user, organizationId, membership } = await getCurrentMembership();

  if (!canManagePortalAccess(membership.role)) {
    throw new Error("You don't have permission to manage client portal access.");
  }

  const invitation = await prisma.clientInvitation.findFirst({
    where: { id: invitationId, client: { organizationId } },
    select: {
      id: true,
      email: true,
      status: true,
      clientId: true,
      client: { select: { name: true } },
    },
  });

  if (!invitation) {
    throw new Error("Invitation not found.");
  }

  if (invitation.status === "PENDING") {
    // Update and its Activity row are one atomic unit.
    await prisma.$transaction(async (tx) => {
      await tx.clientInvitation.update({
        where: { id: invitation.id },
        data: { status: "REVOKED" },
      });

      await createActivity(tx, {
        organizationId,
        actorId: user.id,
        entityType: "PORTAL_USER",
        entityId: invitation.id,
        action: "PORTAL_INVITATION_CANCELED",
        metadata: buildPortalInvitationMetadata(invitation, invitation.client.name, user.name),
      });
    });
  }
  // Any other status (most commonly already REVOKED, from a repeat click)
  // is left untouched — canceling is idempotent, never an error, the token
  // is never cleared or reused, and no Activity is created for a no-op
  // repeat cancel.

  revalidatePath(`/clients/${invitation.clientId}/edit`);
}

export async function removePortalUserAction(portalUserId: string): Promise<void> {
  const { user, organizationId, membership } = await getCurrentMembership();

  if (!canManagePortalAccess(membership.role)) {
    throw new Error("You don't have permission to manage client portal access.");
  }

  // Scoped by id + client.organizationId together, same reasoning as every
  // other lookup here. Deleting this row never touches the Supabase Auth
  // user it belongs to — it only revokes this app's own portal access.
  const portalUser = await prisma.portalUser.findFirst({
    where: { id: portalUserId, client: { organizationId } },
    select: {
      id: true,
      name: true,
      email: true,
      clientId: true,
      client: { select: { name: true } },
    },
  });

  if (!portalUser) {
    throw new Error("Portal user not found.");
  }

  // Delete and its Activity row are one atomic unit — snapshot the portal
  // user's name/email now, since Activity.entityId isn't a foreign key and
  // this row won't exist to look them up from after the delete.
  await prisma.$transaction(async (tx) => {
    await tx.portalUser.delete({ where: { id: portalUser.id } });

    await createActivity(tx, {
      organizationId,
      actorId: user.id,
      entityType: "PORTAL_USER",
      entityId: portalUser.id,
      action: "PORTAL_USER_REMOVED",
      metadata: buildPortalUserRemovedMetadata(portalUser, portalUser.client.name, user.name),
    });
  });

  revalidatePath(`/clients/${portalUser.clientId}/edit`);
}
