import { randomUUID } from "node:crypto";
import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getCurrentPortalUser, getOptionalPortalUser } from "@/lib/current-portal-user";
import { isPortalWelcomeEligible, PORTAL_WELCOME_WINDOW_MS } from "@/components/portal/portal-welcome-eligibility";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { setMockAuthUser, resetAuthMock } from "../../support/auth-mock";

/**
 * Client Portal welcome banner — Stage 4 (docs/onboarding-architecture.md
 * §17). There is no Server Action, no new table, and no write path at all
 * behind this feature (see portal-welcome-eligibility.ts's own header) — so
 * unlike Stage 2/3's own integration suites, this file's job is narrower:
 * prove the one real signal (`PortalUser.createdAt`, fetched through the
 * real, unmodified getCurrentPortalUser()) round-trips correctly through
 * Postgres, stays isolated per PortalUser, is structurally unreachable for
 * a staff identity, and that nothing here ever writes anywhere.
 */

describe("Client Portal welcome eligibility", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(() => {
    resetAuthMock();
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("a freshly created PortalUser (seedTestData's own fixture) is eligible right now", async () => {
    setMockAuthUser({ id: fixtures.portalUser.id, email: fixtures.portalUser.email });
    const identity = await getCurrentPortalUser();
    expect(isPortalWelcomeEligible(identity.portalUser.createdAt, new Date())).toBe(true);
  });

  it("a PortalUser created well outside the window is not eligible — real createdAt round-tripped through Postgres, not a mocked value", async () => {
    const oldCreatedAt = new Date(Date.now() - PORTAL_WELCOME_WINDOW_MS - 24 * 60 * 60 * 1000);
    const oldPortalUser = await prisma.portalUser.create({
      data: {
        id: randomUUID(),
        clientId: fixtures.clientA.id,
        email: `old-portal-${fixtures.runId}@test.local`,
        name: "Old Portal User",
        createdAt: oldCreatedAt,
      },
    });

    setMockAuthUser({ id: oldPortalUser.id, email: oldPortalUser.email });
    const identity = await getCurrentPortalUser();
    expect(identity.portalUser.createdAt.getTime()).toBe(oldCreatedAt.getTime());
    expect(isPortalWelcomeEligible(identity.portalUser.createdAt, new Date())).toBe(false);

    await prisma.portalUser.delete({ where: { id: oldPortalUser.id } });
  });

  it("two different PortalUsers on different Clients each resolve their own createdAt independently — no cross-contamination", async () => {
    const freshOnClientA = await prisma.portalUser.create({
      data: {
        id: randomUUID(),
        clientId: fixtures.clientA.id,
        email: `fresh-a-${fixtures.runId}@test.local`,
        name: "Fresh A",
      },
    });
    const oldOnClientB = await prisma.portalUser.create({
      data: {
        id: randomUUID(),
        clientId: fixtures.clientB.id,
        email: `old-b-${fixtures.runId}@test.local`,
        name: "Old B",
        createdAt: new Date(Date.now() - PORTAL_WELCOME_WINDOW_MS - 1000),
      },
    });

    setMockAuthUser({ id: freshOnClientA.id, email: freshOnClientA.email });
    const identityA = await getCurrentPortalUser();
    expect(identityA.clientId).toBe(fixtures.clientA.id);
    expect(isPortalWelcomeEligible(identityA.portalUser.createdAt, new Date())).toBe(true);

    setMockAuthUser({ id: oldOnClientB.id, email: oldOnClientB.email });
    const identityB = await getCurrentPortalUser();
    expect(identityB.clientId).toBe(fixtures.clientB.id);
    expect(isPortalWelcomeEligible(identityB.portalUser.createdAt, new Date())).toBe(false);

    await prisma.portalUser.deleteMany({ where: { id: { in: [freshOnClientA.id, oldOnClientB.id] } } });
  });

  it("a staff identity (Membership, no PortalUser row) resolves no portal identity at all — structurally cannot reach welcome eligibility", async () => {
    setMockAuthUser({ id: fixtures.owner.id, email: fixtures.owner.email });
    const identity = await getOptionalPortalUser();
    expect(identity).toBeNull();
  });

  it("resolving the current portal identity writes no Activity, Notification, or OrganizationOnboardingStep row", async () => {
    const beforeActivity = await prisma.activity.count({ where: { organizationId: fixtures.orgA.id } });
    const beforeNotification = await prisma.notification.count({ where: { organizationId: fixtures.orgA.id } });
    const beforeOnboarding = await prisma.organizationOnboardingStep.count({ where: { organizationId: fixtures.orgA.id } });

    setMockAuthUser({ id: fixtures.portalUser.id, email: fixtures.portalUser.email });
    const identity = await getCurrentPortalUser();
    isPortalWelcomeEligible(identity.portalUser.createdAt, new Date());

    expect(await prisma.activity.count({ where: { organizationId: fixtures.orgA.id } })).toBe(beforeActivity);
    expect(await prisma.notification.count({ where: { organizationId: fixtures.orgA.id } })).toBe(beforeNotification);
    expect(await prisma.organizationOnboardingStep.count({ where: { organizationId: fixtures.orgA.id } })).toBe(
      beforeOnboarding,
    );
  });
});
