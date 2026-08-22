"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Prisma } from "@/generated/prisma/client";
import { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import {
  getCurrentMembership,
  getOrCreateOrganizationId,
  setActiveOrganization,
} from "@/lib/current-user";
import { parseInviteForm } from "@/lib/validation/invitation";
import { withToast } from "@/lib/toast-url";
import { sendInvitationEmail } from "@/lib/email/invitations";
import { deliverNotificationEmails } from "@/lib/notifications/email/deliver-notification-email";
import { createActivity } from "@/lib/activity/create-activity";
import {
  buildInvitationMetadata,
  buildMembershipMetadata,
  buildRoleChangedMetadata,
  buildOwnershipTransferredMetadata,
} from "@/lib/activity/team-metadata";
import { checkRateLimit, INVITE_MEMBER_LIMIT, RESEND_MEMBER_INVITE_LIMIT } from "@/lib/rate-limit";
import { assertCanInviteMember, BillingLimitError } from "@/lib/billing/enforcement";
import type { InvitationFormState, MembershipActionState } from "@/types";

const CHANGEABLE_ROLES = [Role.MEMBER, Role.ADMIN, Role.OWNER];

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function inviteMemberAction(
  _prevState: InvitationFormState,
  formData: FormData,
): Promise<InvitationFormState> {
  const { values, fieldErrors } = parseInviteForm(formData);

  if (Object.keys(fieldErrors).length > 0) {
    return { error: null, fieldErrors };
  }

  const { user, organizationId, membership } = await getCurrentMembership();

  // Server-side gate — the invite form is only ever rendered for
  // OWNER/ADMIN, but a request can be crafted directly, so re-check here.
  if (membership.role !== Role.OWNER && membership.role !== Role.ADMIN) {
    return { error: "You don't have permission to invite members." };
  }

  const limitCheck = checkRateLimit(INVITE_MEMBER_LIMIT, user.id);
  if (limitCheck.limited) {
    return { error: limitCheck.message };
  }

  // If the email already belongs to a platform user who is already a member
  // of this exact organization, there's nothing to invite them to.
  const existingUser = await prisma.user.findUnique({
    where: { email: values.email },
    select: {
      memberships: { where: { organizationId }, select: { id: true } },
    },
  });
  if (existingUser && existingUser.memberships.length > 0) {
    return { error: null, fieldErrors: { email: "Already a member." } };
  }

  const token = randomUUID();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  try {
    // Invitation upsert and its Activity row are one atomic unit — if the
    // Activity insert fails for any reason, the Invitation write rolls
    // back with it. Re-inviting via this form always logs INVITATION_SENT,
    // never INVITATION_RESENT (that's resendInvitationAction's event) —
    // even when the @@unique([organizationId, email]) upsert lands on the
    // "update" branch because a previous invitation to this address was
    // revoked or expired.
    await prisma.$transaction(async (tx) => {
      // Billing & Subscriptions Stage 2 — re-checked from inside this same
      // transaction (docs/billing-architecture.md §7's race handling),
      // immediately before the Invitation write it guards.
      await assertCanInviteMember(organizationId, tx);

      const invitation = await tx.invitation.upsert({
        where: { organizationId_email: { organizationId, email: values.email } },
        create: {
          organizationId,
          email: values.email,
          role: values.role,
          token,
          status: "PENDING",
          expiresAt,
          invitedById: user.id,
        },
        update: {
          role: values.role,
          token,
          status: "PENDING",
          expiresAt,
          invitedById: user.id,
        },
      });

      await createActivity(tx, {
        organizationId,
        actorId: user.id,
        entityType: "INVITATION",
        entityId: invitation.id,
        action: "INVITATION_SENT",
        metadata: buildInvitationMetadata(invitation, user.name),
      });
    });
  } catch (err) {
    if (err instanceof BillingLimitError) {
      return { error: err.message };
    }
    // Two concurrent invites for the same email can still race the upsert's
    // own read-then-write; ask the submitter to retry rather than surface
    // a raw constraint violation.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { error: "Could not create the invitation. Please try again." };
    }
    throw err;
  }

  revalidatePath("/team");

  // The Invitation row and its Activity are already committed at this
  // point — an email provider failure below only affects delivery, never
  // rolls either of them back. The org's name is looked up fresh (not
  // trusted from client input).
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { name: true },
  });

  const emailResult = await sendInvitationEmail({
    to: values.email,
    organizationName: organization.name,
    role: values.role,
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

  return {
    error: null,
    message: "Invitation sent.",
    token,
  };
}

function canManageInvitations(role: Role): boolean {
  return role === Role.OWNER || role === Role.ADMIN;
}

export async function resendInvitationAction(
  invitationId: string,
): Promise<InvitationFormState> {
  const { user, organizationId, membership } = await getCurrentMembership();

  if (!canManageInvitations(membership.role)) {
    return { error: "You don't have permission to manage invitations." };
  }

  // Keyed by the invitation's own id, not the actor or IP — caps how many
  // times any one invitation's email can be re-sent, checked before the
  // lookup below so a rate-limited caller never touches the database.
  const limitCheck = checkRateLimit(RESEND_MEMBER_INVITE_LIMIT, invitationId);
  if (limitCheck.limited) {
    return { error: limitCheck.message };
  }

  // Scoped by id + organizationId together — a foreign org's invitation id
  // simply doesn't match, indistinguishable from a nonexistent one.
  const invitation = await prisma.invitation.findFirst({
    where: { id: invitationId, organizationId },
    select: { id: true, status: true, email: true, role: true },
  });

  if (!invitation) {
    return { error: "Invitation not found." };
  }

  if (invitation.status === "ACCEPTED") {
    return { error: "This invitation has already been accepted." };
  }

  // PENDING, EXPIRED, or REVOKED all get a fresh token/expiry and land back
  // in PENDING — role and email are never touched by a resend. The old
  // token is invalidated by this same update, so only the new one below is
  // ever emailed out. The new token itself is never written into Activity
  // metadata.
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  // Update and its Activity row are one atomic unit.
  await prisma.$transaction(async (tx) => {
    await tx.invitation.update({
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
      entityType: "INVITATION",
      entityId: invitation.id,
      action: "INVITATION_RESENT",
      metadata: buildInvitationMetadata(invitation, user.name),
    });
  });

  revalidatePath("/team");

  // Invitation and its Activity are already committed regardless of what
  // happens next — a delivery failure here never reverts either of them
  // or regenerates the token a second time (this call is made exactly
  // once).
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { name: true },
  });

  const emailResult = await sendInvitationEmail({
    to: invitation.email,
    organizationName: organization.name,
    // Invitation.role is typed as the full Role enum, but inviteMemberAction
    // (the only writer) only ever stores ADMIN/MEMBER — OWNER is excluded by
    // INVITABLE_ROLES — same cast RoleSelect's caller already relies on.
    role: invitation.role as "ADMIN" | "MEMBER",
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

  return {
    error: null,
    message: "Invitation resent.",
    token,
  };
}

export async function cancelInvitationAction(invitationId: string): Promise<void> {
  const { user, organizationId, membership } = await getCurrentMembership();

  if (!canManageInvitations(membership.role)) {
    throw new Error("You don't have permission to manage invitations.");
  }

  const invitation = await prisma.invitation.findFirst({
    where: { id: invitationId, organizationId },
    select: { id: true, status: true, email: true, role: true },
  });

  if (!invitation) {
    throw new Error("Invitation not found.");
  }

  if (invitation.status === "PENDING") {
    // Update and its Activity row are one atomic unit.
    await prisma.$transaction(async (tx) => {
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: "REVOKED" },
      });

      await createActivity(tx, {
        organizationId,
        actorId: user.id,
        entityType: "INVITATION",
        entityId: invitation.id,
        action: "INVITATION_CANCELED",
        metadata: buildInvitationMetadata(invitation, user.name),
      });
    });
  }
  // Any other status (most commonly already REVOKED, from a repeat click)
  // is left untouched — canceling is idempotent, never an error, the token
  // is never cleared or reused, and no Activity is created for a no-op
  // repeat cancel.

  revalidatePath("/team");
}

/**
 * Changes a member's role, or transfers ownership when newRole is OWNER.
 * Only the organization's OWNER may call this. membershipId is always
 * scoped by id + organizationId together — a foreign org's membership id
 * simply doesn't match, indistinguishable from a nonexistent one.
 */
export async function changeRoleAction(
  membershipId: string,
  newRole: Role,
): Promise<MembershipActionState> {
  const { user, organizationId, membership: viewer } = await getCurrentMembership();

  if (viewer.role !== Role.OWNER) {
    return { error: "You don't have permission to change roles." };
  }

  if (!CHANGEABLE_ROLES.includes(newRole)) {
    return { error: "Invalid role." };
  }

  const target = await prisma.membership.findFirst({
    where: { id: membershipId, organizationId },
    select: {
      id: true,
      userId: true,
      role: true,
      user: { select: { name: true, email: true } },
    },
  });

  if (!target) {
    return { error: "Member not found." };
  }

  if (target.userId === user.id) {
    // The invariant (exactly one OWNER) already makes this the only
    // membership that could ever be role OWNER while also being "self", so
    // this also covers "OWNER can't demote themselves via this action" —
    // that has to go through transfer-then-leave instead.
    return { error: "You can't change your own role." };
  }

  if (target.role === newRole) {
    return { error: null };
  }

  if (newRole === Role.OWNER) {
    // Ownership transfer: atomic swap, race-safe via conditional updateMany
    // (not a plain findFirst-then-update) so two concurrent transfer
    // attempts from the same OWNER can't both succeed and leave two
    // OWNERs behind — whichever commits first wins, the second one's
    // conditional demote finds zero matching rows and aborts. Its Activity
    // row is part of the same transaction, so a failed insert rolls back
    // both membership updates too.
    let notificationIds: string[];
    try {
      notificationIds = await prisma.$transaction(async (tx) => {
        const demoted = await tx.membership.updateMany({
          where: { userId: user.id, organizationId, role: Role.OWNER },
          data: { role: Role.ADMIN },
        });
        if (demoted.count !== 1) {
          throw new Error("NOT_OWNER");
        }

        const promoted = await tx.membership.updateMany({
          where: { id: membershipId, organizationId },
          data: { role: Role.OWNER },
        });
        if (promoted.count !== 1) {
          throw new Error("TARGET_NOT_FOUND");
        }

        // One combined event for the whole transfer — not two separate
        // ROLE_CHANGED rows for the demoted/promoted memberships.
        const activity = await createActivity(tx, {
          organizationId,
          actorId: user.id,
          entityType: "MEMBERSHIP",
          entityId: membershipId,
          action: "OWNERSHIP_TRANSFERRED",
          metadata: buildOwnershipTransferredMetadata(user.name, target.user.name, user.name),
          notificationContext: { newOwnerId: target.userId, previousOwnerId: user.id },
        });

        return activity.notificationIds;
      });
    } catch (err) {
      if (err instanceof Error && err.message === "NOT_OWNER") {
        return { error: "You don't have permission to change roles." };
      }
      if (err instanceof Error && err.message === "TARGET_NOT_FOUND") {
        return { error: "Member not found." };
      }
      throw err;
    }

    // Only ever runs once the transaction above has actually committed —
    // an email provider outage must never roll back the ownership
    // transfer, and this call is documented to never throw either way.
    await deliverNotificationEmails(notificationIds);
  } else {
    // Simple ADMIN <-> MEMBER promote/demote. role: { not: OWNER } is
    // defense in depth — the invariant already means target can never be
    // OWNER here (the only OWNER is the viewer, already excluded above).
    // Update and its Activity row are one atomic unit.
    const outcome = await prisma.$transaction(async (tx) => {
      const result = await tx.membership.updateMany({
        where: { id: membershipId, organizationId, role: { not: Role.OWNER } },
        data: { role: newRole },
      });
      if (result.count === 0) {
        return { status: "not_found" as const, notificationIds: [] as string[] };
      }

      const activity = await createActivity(tx, {
        organizationId,
        actorId: user.id,
        entityType: "MEMBERSHIP",
        entityId: membershipId,
        action: "ROLE_CHANGED",
        metadata: buildRoleChangedMetadata(target.user, target.role, newRole, user.name),
        notificationContext: { affectedUserId: target.userId },
      });

      return { status: "updated" as const, notificationIds: activity.notificationIds };
    });

    if (outcome.status === "not_found") {
      return { error: "Member not found." };
    }

    await deliverNotificationEmails(outcome.notificationIds);
  }

  revalidatePath("/team");
  return { error: null };
}

/**
 * Removes another member from the organization. Only the OWNER may call
 * this, and never on themselves — self-removal only happens through
 * leaveOrganizationAction, which additionally enforces the
 * always-one-OWNER invariant.
 */
export async function removeMemberAction(membershipId: string): Promise<void> {
  const { user, organizationId, membership: viewer } = await getCurrentMembership();

  if (viewer.role !== Role.OWNER) {
    throw new Error("You don't have permission to remove members.");
  }

  const target = await prisma.membership.findFirst({
    where: { id: membershipId, organizationId },
    select: {
      id: true,
      userId: true,
      role: true,
      user: { select: { name: true, email: true } },
    },
  });

  if (!target) {
    throw new Error("Member not found.");
  }

  if (target.userId === user.id) {
    throw new Error('Use "Leave organization" to remove yourself.');
  }

  if (target.role === Role.OWNER) {
    // Unreachable given the invariant (the only OWNER is always the
    // viewer, excluded above) — kept as defense in depth.
    throw new Error("You can't remove the organization owner.");
  }

  // Delete and its Activity row are one atomic unit — snapshot the member's
  // name/email now, since Activity.entityId isn't a foreign key and this
  // row won't exist to look them up from after the delete.
  const notificationIds = await prisma.$transaction(async (tx) => {
    const result = await tx.membership.deleteMany({ where: { id: membershipId, organizationId } });
    if (result.count === 0) {
      return [];
    }

    const activity = await createActivity(tx, {
      organizationId,
      actorId: user.id,
      entityType: "MEMBERSHIP",
      entityId: membershipId,
      action: "MEMBER_REMOVED",
      metadata: buildMembershipMetadata(target.user, target.role, user.name),
      notificationContext: { affectedUserId: target.userId },
    });

    return activity.notificationIds;
  });

  // Post-commit, best-effort — see deliverNotificationEmails's own header.
  await deliverNotificationEmails(notificationIds);

  revalidatePath("/team");
}

/**
 * Lets the current user leave their active organization. An OWNER can only
 * leave once another OWNER exists — since the rest of this codebase
 * enforces "exactly one OWNER at all times", that condition can only be
 * met by first transferring ownership via changeRoleAction, which demotes
 * the caller to ADMIN; leaving then proceeds via the ADMIN/MEMBER path.
 */
export async function leaveOrganizationAction(): Promise<void> {
  const { user, organizationId, membership } = await getCurrentMembership();

  try {
    await prisma.$transaction(async (tx) => {
      if (membership.role === Role.OWNER) {
        const ownerCount = await tx.membership.count({
          where: { organizationId, role: Role.OWNER },
        });
        if (ownerCount <= 1) {
          throw new Error("SOLE_OWNER");
        }
      }
      await tx.membership.delete({ where: { id: membership.id } });

      // Self-referential, like INVITATION_ACCEPTED — the actor leaving IS
      // the member, so memberName/actorName are the same value here.
      await createActivity(tx, {
        organizationId,
        actorId: user.id,
        entityType: "MEMBERSHIP",
        entityId: membership.id,
        action: "MEMBER_LEFT",
        metadata: buildMembershipMetadata(
          { name: user.name, email: user.email },
          membership.role,
          user.name,
        ),
      });
    });
  } catch (err) {
    if (err instanceof Error && err.message === "SOLE_OWNER") {
      throw new Error(
        "You're the only owner. Transfer ownership to someone else before leaving.",
      );
    }
    throw err;
  }

  // Land somewhere valid: another existing membership if they have one
  // (most recently created first), otherwise their own personal OWNER
  // organization, auto-provisioned via the same Stage 2 mechanism every
  // other first-time resolution already uses.
  const anotherMembership = await prisma.membership.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: { organizationId: true },
  });

  const nextOrganizationId = anotherMembership
    ? anotherMembership.organizationId
    : await getOrCreateOrganizationId(user);

  await setActiveOrganization(nextOrganizationId);

  revalidatePath("/dashboard");
  revalidatePath("/team");

  redirect(withToast("/dashboard", "Left organization"));
}
