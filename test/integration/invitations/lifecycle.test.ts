import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { Role } from "@/generated/prisma/enums";
import {
  resendInvitationAction,
  cancelInvitationAction,
} from "@/app/(dashboard)/team/actions";
import { acceptInvitationAction } from "@/app/invite/[token]/actions";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, setMockAuthUser, resetAuthMock } from "../../support/auth-mock";
import { RedirectSignal, resetNavigationMock } from "../../support/navigation-mock";
import { testEmail } from "../../support/run-id";
import { TEST_EMAIL_DOMAIN } from "../../support/env";

async function createInvitation(
  fixtures: TestFixtures,
  overrides: Partial<{ status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED"; expiresAt: Date; role: Role }>,
) {
  return prisma.invitation.create({
    data: {
      organizationId: fixtures.orgA.id,
      email: testEmail(`lifecycle-${randomUUID().slice(0, 8)}`, TEST_EMAIL_DOMAIN, fixtures.runId),
      role: overrides.role ?? Role.MEMBER,
      token: randomUUID(),
      status: overrides.status ?? "PENDING",
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      invitedById: fixtures.owner.id,
    },
  });
}

describe("staff invitation state machine", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(() => {
    resetAuthMock();
    resetNavigationMock();
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("resend on a PENDING invitation rotates the token and stays PENDING", async () => {
    const invitation = await createInvitation(fixtures, { status: "PENDING" });
    actAs(fixtures.owner, fixtures.orgA.id);

    const result = await resendInvitationAction(invitation.id);

    expect(result.error).toBeNull();
    const updated = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(updated.status).toBe("PENDING");
    expect(updated.token).not.toBe(invitation.token);

    await prisma.invitation.delete({ where: { id: invitation.id } });
  });

  it("resend on an ACCEPTED invitation is rejected and does not touch the row", async () => {
    const invitation = await createInvitation(fixtures, { status: "ACCEPTED" });
    actAs(fixtures.owner, fixtures.orgA.id);

    const result = await resendInvitationAction(invitation.id);

    expect(result.error).toBe("This invitation has already been accepted.");
    const unchanged = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(unchanged.token).toBe(invitation.token);

    await prisma.invitation.delete({ where: { id: invitation.id } });
  });

  it("resend on a REVOKED invitation succeeds and revives it to PENDING", async () => {
    const invitation = await createInvitation(fixtures, { status: "REVOKED" });
    actAs(fixtures.owner, fixtures.orgA.id);

    const result = await resendInvitationAction(invitation.id);

    expect(result.error).toBeNull();
    const revived = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(revived.status).toBe("PENDING");

    await prisma.invitation.delete({ where: { id: invitation.id } });
  });

  it("resend on an EXPIRED (status) invitation succeeds and revives it to PENDING with a fresh expiry", async () => {
    const invitation = await createInvitation(fixtures, {
      status: "PENDING",
      expiresAt: new Date(Date.now() - 1000), // already past, still PENDING status
    });
    actAs(fixtures.owner, fixtures.orgA.id);

    const result = await resendInvitationAction(invitation.id);

    expect(result.error).toBeNull();
    const revived = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(revived.expiresAt.getTime()).toBeGreaterThan(Date.now());

    await prisma.invitation.delete({ where: { id: invitation.id } });
  });

  it("cancel is idempotent: a second cancel on an already-REVOKED invitation is a silent no-op", async () => {
    const invitation = await createInvitation(fixtures, { status: "PENDING" });
    actAs(fixtures.owner, fixtures.orgA.id);

    await cancelInvitationAction(invitation.id);
    const afterFirst = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(afterFirst.status).toBe("REVOKED");

    const activityCountBefore = await prisma.activity.count({ where: { entityId: invitation.id } });
    await cancelInvitationAction(invitation.id); // repeat cancel
    const activityCountAfter = await prisma.activity.count({ where: { entityId: invitation.id } });

    expect(activityCountAfter).toBe(activityCountBefore); // no second CANCELED activity logged

    await prisma.invitation.delete({ where: { id: invitation.id } });
  });

  it("accepting an expired invitation is rejected with a specific message, and the row is untouched", async () => {
    const invitation = await createInvitation(fixtures, {
      status: "PENDING",
      expiresAt: new Date(Date.now() - 1000),
    });
    setMockAuthUser({ id: randomUUID(), email: invitation.email });
    // No matching Prisma User yet — getOrCreateUser() will create one.

    const result = await acceptInvitationAction(invitation.token);

    expect(result.error).toBe("This invitation has expired.");
    const unchanged = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(unchanged.status).toBe("PENDING");

    await prisma.user.deleteMany({ where: { email: invitation.email } });
    await prisma.invitation.delete({ where: { id: invitation.id } });
  });

  it("accepting a REVOKED invitation is rejected with the generic unavailable message", async () => {
    const invitation = await createInvitation(fixtures, { status: "REVOKED" });
    setMockAuthUser({ id: randomUUID(), email: invitation.email });

    const result = await acceptInvitationAction(invitation.token);

    expect(result.error).toBe("This invitation is no longer available.");

    await prisma.user.deleteMany({ where: { email: invitation.email } });
    await prisma.invitation.delete({ where: { id: invitation.id } });
  });

  it("accepting a PENDING invitation succeeds: creates exactly one Membership and one INVITATION_ACCEPTED Activity", async () => {
    const invitation = await createInvitation(fixtures, { status: "PENDING" });
    const authUserId = randomUUID();
    setMockAuthUser({ id: authUserId, email: invitation.email });

    await expect(acceptInvitationAction(invitation.token)).rejects.toThrow(RedirectSignal);

    const membership = await prisma.membership.findUnique({
      where: { userId_organizationId: { userId: authUserId, organizationId: fixtures.orgA.id } },
    });
    expect(membership).not.toBeNull();
    expect(membership?.role).toBe(Role.MEMBER);

    const updatedInvitation = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(updatedInvitation.status).toBe("ACCEPTED");

    const activity = await prisma.activity.findFirst({
      where: { entityId: invitation.id, action: "INVITATION_ACCEPTED" },
    });
    expect(activity).not.toBeNull();

    await prisma.membership.deleteMany({ where: { userId: authUserId } });
    await prisma.invitation.delete({ where: { id: invitation.id } });
    await prisma.user.deleteMany({ where: { id: authUserId } });
  });

  it("accepting an already-ACCEPTED invitation a second time is idempotent (no duplicate Membership/Activity)", async () => {
    const invitation = await createInvitation(fixtures, { status: "PENDING" });
    const authUserId = randomUUID();
    setMockAuthUser({ id: authUserId, email: invitation.email });

    await expect(acceptInvitationAction(invitation.token)).rejects.toThrow(RedirectSignal);
    // Second accept of the same token, same identity, already ACCEPTED.
    const secondAttempt = await acceptInvitationAction(invitation.token).catch((e) => {
      if (e instanceof RedirectSignal) return { error: null, redirected: true };
      throw e;
    });
    expect(secondAttempt).toBeTruthy();

    const membershipCount = await prisma.membership.count({
      where: { userId: authUserId, organizationId: fixtures.orgA.id },
    });
    expect(membershipCount).toBe(1);
    const activityCount = await prisma.activity.count({
      where: { entityId: invitation.id, action: "INVITATION_ACCEPTED" },
    });
    expect(activityCount).toBe(1);

    await prisma.membership.deleteMany({ where: { userId: authUserId } });
    await prisma.invitation.delete({ where: { id: invitation.id } });
    await prisma.user.deleteMany({ where: { id: authUserId } });
  });

  it("accepting with a mismatched email is rejected without creating any Membership", async () => {
    const invitation = await createInvitation(fixtures, { status: "PENDING" });
    const mismatchedEmail = `someone-else-${randomUUID().slice(0, 8)}@${TEST_EMAIL_DOMAIN}`;
    setMockAuthUser({ id: randomUUID(), email: mismatchedEmail });

    const result = await acceptInvitationAction(invitation.token);

    expect(result.error).toBe("This invitation was sent to a different email address.");
    const stillPending = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(stillPending.status).toBe("PENDING");

    // getOrCreateUser() runs before the email-match check, so it already
    // created a User row for this mock identity — clean it up too.
    await prisma.user.deleteMany({ where: { email: mismatchedEmail } });
    await prisma.invitation.delete({ where: { id: invitation.id } });
  });

  it("an invitation tampered to role OWNER is rejected outright", async () => {
    const invitation = await createInvitation(fixtures, { status: "PENDING", role: Role.OWNER });
    setMockAuthUser({ id: randomUUID(), email: invitation.email });

    const result = await acceptInvitationAction(invitation.token);

    expect(result.error).toBe("This invitation cannot be accepted.");

    // getOrCreateUser() runs before the role check, so it already created
    // a User row for this mock identity — clean it up too.
    await prisma.user.deleteMany({ where: { email: invitation.email } });
    await prisma.invitation.delete({ where: { id: invitation.id } });
  });
});
