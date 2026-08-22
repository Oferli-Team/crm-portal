import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { acceptClientInvitationAction } from "@/app/portal/invite/[token]/actions";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { setMockAuthUser, resetAuthMock } from "../../support/auth-mock";
import { RedirectSignal, resetNavigationMock } from "../../support/navigation-mock";
import { testEmail } from "../../support/run-id";
import { TEST_EMAIL_DOMAIN } from "../../support/env";

/**
 * Portal Analytics persistence foundation (docs/analytics-architecture.md
 * §12, Slice 1) — a genuine PENDING -> ACCEPTED transition counts as this
 * identity's first active portal session, so lastLoginAt is set inside
 * the same upsert that already gates on that exact transition (see the
 * action's own updated doc comment). test/integration/invitations/
 * concurrent-accept.test.ts already covers the race-safety proof this
 * relies on; these tests cover the login-tracking dimension specifically,
 * including the update-branch edge case and the still-rejected conflict
 * case.
 */
describe("acceptClientInvitationAction — Portal Analytics login tracking", () => {
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

  it("a genuine first acceptance creates the PortalUser with a non-null lastLoginAt", async () => {
    const email = testEmail("first-accept", TEST_EMAIL_DOMAIN, fixtures.runId);
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

    const before = new Date();
    await expect(acceptClientInvitationAction(invitation.token)).rejects.toBeInstanceOf(RedirectSignal);
    const after = new Date();

    const portalUser = await prisma.portalUser.findUniqueOrThrow({ where: { id: authUserId } });
    expect(portalUser.lastLoginAt).not.toBeNull();
    expect(portalUser.lastLoginAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(portalUser.lastLoginAt!.getTime()).toBeLessThanOrEqual(after.getTime());

    await prisma.portalUser.deleteMany({ where: { id: authUserId } });
    await prisma.clientInvitation.deleteMany({ where: { id: invitation.id } });
  });

  it("a genuine new pending invitation for an identity that already has a same-client PortalUser (e.g. accepted under a since-changed email) updates lastLoginAt via the upsert's update branch, without reassigning clientId or touching email/name", async () => {
    const authUserId = randomUUID();
    const oldEmail = testEmail("old-address", TEST_EMAIL_DOMAIN, fixtures.runId);
    const newEmail = testEmail("new-address", TEST_EMAIL_DOMAIN, fixtures.runId);

    // Simulates an earlier acceptance under a different email — same auth
    // id, same Client, no lastLoginAt yet (predates this feature or was
    // never set for some other reason).
    await prisma.portalUser.create({
      data: { id: authUserId, clientId: fixtures.clientA.id, email: oldEmail, name: "Old Name" },
    });

    const invitation = await prisma.clientInvitation.create({
      data: {
        clientId: fixtures.clientA.id,
        email: newEmail,
        token: randomUUID(),
        status: "PENDING",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        invitedById: fixtures.owner.id,
      },
    });
    setMockAuthUser({ id: authUserId, email: newEmail });

    await expect(acceptClientInvitationAction(invitation.token)).rejects.toBeInstanceOf(RedirectSignal);

    const portalUser = await prisma.portalUser.findUniqueOrThrow({ where: { id: authUserId } });
    expect(portalUser.lastLoginAt).not.toBeNull();
    expect(portalUser.clientId).toBe(fixtures.clientA.id);
    // Only lastLoginAt is added to the update branch — email/name stay
    // exactly as the existing behavior already leaves them.
    expect(portalUser.email).toBe(oldEmail);
    expect(portalUser.name).toBe("Old Name");

    await prisma.portalUser.deleteMany({ where: { id: authUserId } });
    await prisma.clientInvitation.deleteMany({ where: { id: invitation.id } });
  });

  it("re-clicking an already-accepted invitation does not change lastLoginAt", async () => {
    const email = testEmail("already-accepted", TEST_EMAIL_DOMAIN, fixtures.runId);
    const authUserId = randomUUID();
    const originalLoginAt = new Date("2026-08-01T00:00:00.000Z");
    await prisma.portalUser.create({
      data: {
        id: authUserId,
        clientId: fixtures.clientA.id,
        email,
        name: "Already Accepted",
        lastLoginAt: originalLoginAt,
      },
    });
    const invitation = await prisma.clientInvitation.create({
      data: {
        clientId: fixtures.clientA.id,
        email,
        token: randomUUID(),
        status: "ACCEPTED",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        invitedById: fixtures.owner.id,
      },
    });
    setMockAuthUser({ id: authUserId, email });

    // redirectIfAlreadyAccepted() fires before the transaction ever runs
    // — the upsert (and lastLoginAt) is never reached.
    await expect(acceptClientInvitationAction(invitation.token)).rejects.toBeInstanceOf(RedirectSignal);

    const portalUser = await prisma.portalUser.findUniqueOrThrow({ where: { id: authUserId } });
    expect(portalUser.lastLoginAt?.toISOString()).toBe(originalLoginAt.toISOString());

    await prisma.portalUser.deleteMany({ where: { id: authUserId } });
    await prisma.clientInvitation.deleteMany({ where: { id: invitation.id } });
  });

  it("a conflicting different-client PortalUser is still rejected — clientId and lastLoginAt are left untouched", async () => {
    const authUserId = randomUUID();
    const email = testEmail("conflicting", TEST_EMAIL_DOMAIN, fixtures.runId);
    const originalLoginAt = new Date("2026-08-01T00:00:00.000Z");
    await prisma.portalUser.create({
      data: {
        id: authUserId,
        clientId: fixtures.clientA.id,
        email,
        name: "Conflicting User",
        lastLoginAt: originalLoginAt,
      },
    });
    // A new invitation for a *different* Client, same email/auth identity.
    const invitation = await prisma.clientInvitation.create({
      data: {
        clientId: fixtures.clientB.id,
        email,
        token: randomUUID(),
        status: "PENDING",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        invitedById: fixtures.orgBOwner.id,
      },
    });
    setMockAuthUser({ id: authUserId, email });

    const result = await acceptClientInvitationAction(invitation.token);
    expect(result.error).toBe("This invitation is no longer available.");

    const portalUser = await prisma.portalUser.findUniqueOrThrow({ where: { id: authUserId } });
    expect(portalUser.clientId).toBe(fixtures.clientA.id);
    expect(portalUser.lastLoginAt?.toISOString()).toBe(originalLoginAt.toISOString());

    // The conflicting invitation itself must remain untouched (still
    // PENDING) — the rejection happens before the updateMany, per the
    // action's own transaction ordering.
    const finalInvitation = await prisma.clientInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(finalInvitation.status).toBe("PENDING");

    await prisma.portalUser.deleteMany({ where: { id: authUserId } });
    await prisma.clientInvitation.deleteMany({ where: { id: invitation.id } });
  });
});
