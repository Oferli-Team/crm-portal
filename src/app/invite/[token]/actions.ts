"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { getOrCreateUser, setActiveOrganization } from "@/lib/current-user";
import { withToast } from "@/lib/toast-url";
import { createActivity } from "@/lib/activity/create-activity";
import { deliverNotificationEmails } from "@/lib/notifications/email/deliver-notification-email";
import { buildInvitationAcceptedMetadata } from "@/lib/activity/team-metadata";
import { checkRateLimit, getRequestIp, ACCEPT_MEMBER_INVITE_LIMIT } from "@/lib/rate-limit";
import type { InviteAcceptState } from "@/types";

const GENERIC_UNAVAILABLE_ERROR = "This invitation is no longer available.";

/**
 * If the current user already holds a Membership in this organization,
 * finishes the accept flow without any further mutation — used both for a
 * plain double-click and for the rarer case where a concurrent request
 * already completed the accept transaction by the time this one re-checks.
 * Never returns when it redirects.
 */
async function redirectIfAlreadyMember(
  userId: string,
  organizationId: string,
): Promise<void> {
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId } },
  });

  if (membership) {
    await setActiveOrganization(organizationId);
    revalidatePath("/dashboard");
    revalidatePath("/team");
    redirect(withToast("/dashboard", "Joined organization"));
  }
}

export async function acceptInvitationAction(
  token: string,
): Promise<InviteAcceptState> {
  const ip = await getRequestIp();
  const limitCheck = checkRateLimit(ACCEPT_MEMBER_INVITE_LIMIT, ip);
  if (limitCheck.limited) {
    return { error: limitCheck.message };
  }

  // Ensures a Prisma User row exists for the authenticated Supabase user,
  // without requiring (or provisioning) an active organization — accepting
  // an invite must work independently of whatever org this user already
  // belongs to, if any.
  const user = await getOrCreateUser();

  // The token is the sole authorization boundary here — never scoped by
  // the caller's active organizationId, which would be irrelevant (and
  // wrong) for joining a *different* one.
  const invitation = await prisma.invitation.findUnique({ where: { token } });

  if (!invitation) {
    return { error: "Invitation not found or no longer available." };
  }

  if (invitation.status === "ACCEPTED") {
    // Idempotent re-click / duplicate tab: if it's already this user's
    // membership, finish quietly instead of erroring.
    await redirectIfAlreadyMember(user.id, invitation.organizationId);
    return { error: GENERIC_UNAVAILABLE_ERROR };
  }

  if (invitation.status !== "PENDING") {
    // REVOKED, or a status this stage never produces.
    return { error: GENERIC_UNAVAILABLE_ERROR };
  }

  if (invitation.expiresAt.getTime() <= Date.now()) {
    return { error: "This invitation has expired." };
  }

  // Never let an invitation grant OWNER, even if the row was tampered with
  // directly at the data layer.
  if (invitation.role === Role.OWNER) {
    return { error: "This invitation cannot be accepted." };
  }

  const normalizedUserEmail = (user.email ?? "").trim().toLowerCase();
  const normalizedInviteEmail = invitation.email.trim().toLowerCase();
  if (normalizedUserEmail !== normalizedInviteEmail) {
    return { error: "This invitation was sent to a different email address." };
  }

  let notificationIds: string[];
  try {
    notificationIds = await prisma.$transaction(async (tx) => {
      // Re-read and re-validate inside the transaction to close the gap
      // between the checks above and this write (e.g. a concurrent cancel
      // or a second tab racing the same accept).
      const fresh = await tx.invitation.findUnique({ where: { id: invitation.id } });
      if (
        !fresh ||
        fresh.status !== "PENDING" ||
        fresh.expiresAt.getTime() <= Date.now() ||
        fresh.role === Role.OWNER
      ) {
        throw new Error("STALE_INVITATION");
      }

      // upsert, not create: @@unique([userId, organizationId]) means a
      // second concurrent accept for the same person must not throw —
      // it should just confirm the membership already exists.
      await tx.membership.upsert({
        where: { userId_organizationId: { userId: user.id, organizationId: fresh.organizationId } },
        create: { userId: user.id, organizationId: fresh.organizationId, role: fresh.role },
        update: {},
      });

      await tx.invitation.update({
        where: { id: fresh.id },
        data: { status: "ACCEPTED" },
      });

      // Only reached on a genuine first-time PENDING -> ACCEPTED
      // transition (the checks above throw STALE_INVITATION otherwise),
      // so a duplicate/concurrent accept never logs a second event here.
      // Self-referential, like leaveOrganizationAction — the actor
      // accepting IS the new member.
      const activity = await createActivity(tx, {
        organizationId: fresh.organizationId,
        actorId: user.id,
        entityType: "INVITATION",
        entityId: fresh.id,
        action: "INVITATION_ACCEPTED",
        metadata: buildInvitationAcceptedMetadata(fresh, user.name, user.name),
        notificationContext: { invitedById: fresh.invitedById },
      });

      return activity.notificationIds;
    });
  } catch (err) {
    if (err instanceof Error && err.message === "STALE_INVITATION") {
      // Most likely a concurrent duplicate submit that already succeeded
      // under someone else's transaction — finish quietly if so.
      await redirectIfAlreadyMember(user.id, invitation.organizationId);
      return { error: GENERIC_UNAVAILABLE_ERROR };
    }
    throw err;
  }

  // INVITATION_ACCEPTED is not on the email allowlist (see deliver-
  // notification-email.ts) — this always resolves to a SKIPPED delivery
  // row, never an email. Called anyway so every notification-producing
  // call site follows the same uniform post-commit pattern; the allowlist
  // decision lives once, in the helper, not duplicated at each call site.
  await deliverNotificationEmails(notificationIds);

  await setActiveOrganization(invitation.organizationId);

  revalidatePath("/dashboard");
  revalidatePath("/team");

  redirect(withToast("/dashboard", "Joined organization"));
}

export async function signOutForInviteAction(token: string): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect(`/login?redirectTo=${encodeURIComponent(`/invite/${token}`)}`);
}
