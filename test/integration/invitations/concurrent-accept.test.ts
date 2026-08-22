import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { Role } from "@/generated/prisma/enums";
import { acceptInvitationAction } from "@/app/invite/[token]/actions";
import { acceptClientInvitationAction } from "@/app/portal/invite/[token]/actions";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { setMockAuthUser, resetAuthMock } from "../../support/auth-mock";
import { RedirectSignal, resetNavigationMock } from "../../support/navigation-mock";
import { testEmail } from "../../support/run-id";
import { TEST_EMAIL_DOMAIN } from "../../support/env";

// The most important integration test in Stage 4. Both acceptInvitationAction
// and acceptClientInvitationAction guard their write with a conditional
// updateMany (`status: "PENDING"` in the WHERE clause) inside one
// prisma.$transaction — only the request that actually flips PENDING ->
// ACCEPTED proceeds to upsert the Membership/PortalUser; every other
// concurrent request finds zero matching rows and takes the
// "STALE_INVITATION" branch instead of creating a second row.
//
// Caveat, stated plainly: PGlite's socket server can only service one
// connection at a time (see src/lib/prisma.ts's PGLITE_TEST_DB pool cap),
// so these "concurrent" calls are serialized onto one physical connection
// rather than truly racing at the database level the way two separate
// connections against a real multi-connection Postgres would. What this
// test DOES prove — and it's the part that actually matters — is that the
// action's own conditional-update logic is correct: calling it twice for
// the same token never produces a second Membership/PortalUser or a
// second ACCEPTED-event Activity row, and neither call throws an
// uncaught exception. True multi-connection race timing is out of scope
// for this sandbox; see the Stage 4 report.

describe("concurrent invitation accept", () => {
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

  it("staff accept: two simultaneous acceptInvitationAction calls produce exactly one Membership and one Activity", async () => {
    const email = testEmail("concurrent-staff", TEST_EMAIL_DOMAIN, fixtures.runId);
    const authUserId = randomUUID();
    const invitation = await prisma.invitation.create({
      data: {
        organizationId: fixtures.orgA.id,
        email,
        role: Role.MEMBER,
        token: randomUUID(),
        status: "PENDING",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        invitedById: fixtures.owner.id,
      },
    });
    setMockAuthUser({ id: authUserId, email });

    const outcomes = await Promise.allSettled([
      acceptInvitationAction(invitation.token),
      acceptInvitationAction(invitation.token),
    ]);

    // Neither call may reject with anything other than the expected
    // redirect control-flow signal — no uncaught/unexpected exception.
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(RedirectSignal);
      }
    }

    const memberships = await prisma.membership.findMany({
      where: { userId: authUserId, organizationId: fixtures.orgA.id },
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0].role).toBe(Role.MEMBER);

    const acceptedActivities = await prisma.activity.count({
      where: { entityId: invitation.id, action: "INVITATION_ACCEPTED" },
    });
    expect(acceptedActivities).toBe(1);

    const finalInvitation = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(finalInvitation.status).toBe("ACCEPTED");

    await prisma.membership.deleteMany({ where: { userId: authUserId } });
    await prisma.invitation.delete({ where: { id: invitation.id } });
    await prisma.user.deleteMany({ where: { id: authUserId } });
  });

  it("portal accept: two simultaneous acceptClientInvitationAction calls produce exactly one PortalUser and one Activity", async () => {
    const email = testEmail("concurrent-portal", TEST_EMAIL_DOMAIN, fixtures.runId);
    const authUserId = randomUUID();
    const invitation = await prisma.clientInvitation.create({
      data: {
        clientId: fixtures.clientA.id,
        email,
        token: randomUUID(),
        status: "PENDING",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        invitedById: fixtures.owner.id,
      },
    });
    setMockAuthUser({ id: authUserId, email });

    const outcomes = await Promise.allSettled([
      acceptClientInvitationAction(invitation.token),
      acceptClientInvitationAction(invitation.token),
    ]);

    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(RedirectSignal);
      }
    }

    const portalUser = await prisma.portalUser.findUnique({ where: { id: authUserId } });
    expect(portalUser).not.toBeNull();
    expect(portalUser?.clientId).toBe(fixtures.clientA.id);

    const portalUserCount = await prisma.portalUser.count({ where: { clientId: fixtures.clientA.id, id: authUserId } });
    expect(portalUserCount).toBe(1);

    const acceptedActivities = await prisma.activity.count({
      where: { entityId: authUserId, action: "PORTAL_INVITATION_ACCEPTED" },
    });
    expect(acceptedActivities).toBe(1);

    const finalInvitation = await prisma.clientInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(finalInvitation.status).toBe("ACCEPTED");

    await prisma.portalUser.deleteMany({ where: { id: authUserId } });
    await prisma.clientInvitation.delete({ where: { id: invitation.id } });
  });
});
