import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// src/lib/billing/view-model.ts transitively imports src/lib/billing/
// provider/provider.ts, which imports the real "server-only" marker
// package — see test/unit/cron-auth.test.ts's own header comment.
vi.mock("server-only", () => ({}));

import { prisma } from "@/lib/prisma";
import { getBillingPageData } from "@/lib/billing/view-model";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { testEmail, testSlug } from "../../support/run-id";
import { TEST_EMAIL_DOMAIN } from "../../support/env";

/**
 * Billing & Subscriptions Stage 3 (this stage's own §17). Exercises the
 * real, unmodified getBillingPageData() against the real (test) Postgres —
 * no mocks in this file at all, since this function takes organizationId/
 * role as plain parameters and does no auth/session work of its own (that
 * boundary lives in getCurrentMembership(), separately covered by
 * test/integration/billing/actions.test.ts).
 */

describe("getBillingPageData", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();

    await prisma.subscription.create({
      data: {
        organizationId: fixtures.orgA.id,
        planKey: "STARTER",
        status: "ACTIVE",
        trialStartedAt: new Date(),
        trialEndsAt: new Date(),
      },
    });
    await prisma.subscription.create({
      data: {
        organizationId: fixtures.orgB.id,
        planKey: "PRO",
        status: "ACTIVE",
        trialStartedAt: new Date(),
        trialEndsAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await prisma.subscription.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
    await cleanupTestData(fixtures);
  });

  it("is scoped to the given organization — two orgs' data never leaks into each other", async () => {
    const dataA = await getBillingPageData({ organizationId: fixtures.orgA.id, role: "OWNER" });
    const dataB = await getBillingPageData({ organizationId: fixtures.orgB.id, role: "OWNER" });

    expect(dataA.currentPlanKey).toBe("STARTER");
    expect(dataB.currentPlanKey).toBe("PRO");
  });

  it("a missing Subscription row resolves to the LEGACY state, never an error", async () => {
    const legacyOrg = await prisma.organization.create({
      data: { name: "Legacy Org", slug: testSlug("billing-legacy", fixtures.runId) },
    });

    const data = await getBillingPageData({ organizationId: legacyOrg.id, role: "OWNER" });

    expect(data.isLegacy).toBe(true);
    expect(data.statusLabel).toBe("LEGACY");
    expect(data.accessMode).toBe("FULL_ACCESS");
    expect(data.accessModeBanner).toBeNull();

    await prisma.organization.delete({ where: { id: legacyOrg.id } });
  });

  it("Stage 5 audit fix: a real, backfilled LEGACY-plan Subscription row (prisma/backfill-subscriptions.ts's own shape) also resolves to the LEGACY state, not a misleading 'Active' one", async () => {
    const backfilledOrg = await prisma.organization.create({
      data: { name: "Backfilled Legacy Org", slug: testSlug("billing-legacy-backfilled", fixtures.runId) },
    });
    // Exactly what prisma/backfill-subscriptions.ts writes: a real row,
    // planKey LEGACY, status ACTIVE (there is no separate LEGACY
    // SubscriptionStatus value — see that script's own header comment).
    await prisma.subscription.create({
      data: {
        organizationId: backfilledOrg.id,
        planKey: "LEGACY",
        status: "ACTIVE",
        trialStartedAt: new Date(),
        trialEndsAt: new Date(),
      },
    });

    const data = await getBillingPageData({ organizationId: backfilledOrg.id, role: "OWNER" });

    // Before this fix: isLegacy was false and statusLabel was "ACTIVE" —
    // the page would show plan "Legacy (pre-billing)" next to a green
    // "Active" badge and "Your subscription is active," which is false
    // for an organization that has never had a real subscription.
    expect(data.isLegacy).toBe(true);
    expect(data.statusLabel).toBe("LEGACY");
    expect(data.statusNotice.message).toBe("This workspace uses legacy unrestricted access.");
    expect(data.accessMode).toBe("FULL_ACCESS");
    expect(data.accessModeBanner).toBeNull();

    await prisma.subscription.deleteMany({ where: { organizationId: backfilledOrg.id } });
    await prisma.organization.delete({ where: { id: backfilledOrg.id } });
  });

  it("usage rows reflect real Membership/Client/Project/Attachment aggregates, not a separately-computed number", async () => {
    const data = await getBillingPageData({ organizationId: fixtures.orgA.id, role: "OWNER" });

    const [members, clients, projects, storage, pendingInvitations] = await Promise.all([
      prisma.membership.count({ where: { organizationId: fixtures.orgA.id } }),
      prisma.client.count({ where: { organizationId: fixtures.orgA.id } }),
      prisma.project.count({ where: { organizationId: fixtures.orgA.id } }),
      prisma.attachment.aggregate({ where: { organizationId: fixtures.orgA.id }, _sum: { sizeBytes: true } }),
      prisma.invitation.count({ where: { organizationId: fixtures.orgA.id, status: "PENDING" } }),
    ]);

    const membersRow = data.usageRows.find((r) => r.key === "members")!;
    const clientsRow = data.usageRows.find((r) => r.key === "clients")!;
    const projectsRow = data.usageRows.find((r) => r.key === "projects")!;
    const storageRow = data.usageRows.find((r) => r.key === "storage")!;

    expect(clientsRow.current).toBe(clients);
    expect(projectsRow.current).toBe(projects);
    expect(storageRow.current).toBe(storage._sum.sizeBytes ?? 0);
    // members row additionally folds in pending invitations (fixtures.invitation
    // is itself already one such row — see the next test for an isolated delta check).
    expect(membersRow.current).toBe(members + pendingInvitations);
  });

  it("pending invitations are folded into the Members usage row, matching the entitlement engine's own limit check", async () => {
    const before = await getBillingPageData({ organizationId: fixtures.orgA.id, role: "OWNER" });
    const membersBefore = before.usageRows.find((r) => r.key === "members")!.current;

    const invitation = await prisma.invitation.create({
      data: {
        organizationId: fixtures.orgA.id,
        email: testEmail("billing-pending-invite", TEST_EMAIL_DOMAIN, fixtures.runId),
        role: "MEMBER",
        token: randomUUID(),
        status: "PENDING",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        invitedById: fixtures.owner.id,
      },
    });

    const after = await getBillingPageData({ organizationId: fixtures.orgA.id, role: "OWNER" });
    const membersAfter = after.usageRows.find((r) => r.key === "members")!.current;

    expect(membersAfter).toBe(membersBefore + 1);

    await prisma.invitation.delete({ where: { id: invitation.id } });
  });

  it("an over-limit organization is displayed with an EXCEEDED/REACHED status, never hidden or destructive", async () => {
    const tinyOrg = await prisma.organization.create({
      data: { name: "Tiny Org", slug: testSlug("billing-tiny", fixtures.runId) },
    });
    const tinyOwner = await prisma.user.create({
      data: { id: randomUUID(), email: testEmail("billing-tiny-owner", TEST_EMAIL_DOMAIN, fixtures.runId), name: "Tiny Owner" },
    });
    await prisma.membership.create({ data: { userId: tinyOwner.id, organizationId: tinyOrg.id, role: "OWNER" } });
    await prisma.subscription.create({
      data: {
        organizationId: tinyOrg.id,
        planKey: "STARTER",
        status: "ACTIVE",
        trialStartedAt: new Date(),
        trialEndsAt: new Date(),
      },
    });
    // STARTER's maxClients is 10 — 11 real Client rows puts this org over.
    await prisma.client.createMany({
      data: Array.from({ length: 11 }, (_, i) => ({
        name: `Tiny Client ${i}`,
        organizationId: tinyOrg.id,
        userId: tinyOwner.id,
      })),
    });

    const data = await getBillingPageData({ organizationId: tinyOrg.id, role: "OWNER" });
    const clientsRow = data.usageRows.find((r) => r.key === "clients")!;

    expect(clientsRow.status).toBe("EXCEEDED");
    expect(clientsRow.current).toBe(11);

    await prisma.client.deleteMany({ where: { organizationId: tinyOrg.id } });
    await prisma.subscription.deleteMany({ where: { organizationId: tinyOrg.id } });
    await prisma.organization.delete({ where: { id: tinyOrg.id } });
    await prisma.user.delete({ where: { id: tinyOwner.id } });
  });
});
