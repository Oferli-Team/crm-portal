import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getPortalUserGrowthSeries, getPortalInvitationSeries } from "@/lib/analytics/queries/portal-time-series";
import { testEmail, testSlug } from "../../support/run-id";

async function createOrgWithOwner(label: string) {
  const runSuffix = randomUUID().slice(0, 8);
  const owner = await prisma.user.create({
    data: { id: randomUUID(), email: testEmail(`analytics-pts-${label}`, "test.local", runSuffix), name: `Analytics ${label}` },
  });
  const org = await prisma.organization.create({
    data: { name: `Analytics Portal TS Org ${label}`, slug: testSlug(`analytics-pts-${label}`, runSuffix) },
  });
  await prisma.membership.create({ data: { userId: owner.id, organizationId: org.id, role: "OWNER" } });
  return { owner, org };
}

describe("portal time-series queries", () => {
  let org: Awaited<ReturnType<typeof createOrgWithOwner>>;
  let clientId: string;

  beforeAll(async () => {
    org = await createOrgWithOwner("A");
    const clientRow = await prisma.client.create({
      data: { name: "Client with portal", userId: org.owner.id, organizationId: org.org.id, createdAt: new Date("2020-01-01T00:00:00.000Z") },
    });
    clientId = clientRow.id;

    await prisma.portalUser.create({
      data: { id: randomUUID(), clientId, email: testEmail("portal-a", "test.local", randomUUID().slice(0, 8)), name: "Portal A", createdAt: new Date("2026-08-05T00:00:00.000Z") },
    });
    await prisma.portalUser.create({
      data: { id: randomUUID(), clientId, email: testEmail("portal-b", "test.local", randomUUID().slice(0, 8)), name: "Portal B", createdAt: new Date("2026-08-10T00:00:00.000Z") },
    });

    await prisma.activity.create({
      data: { organizationId: org.org.id, actorId: org.owner.id, entityType: "PORTAL_USER", entityId: randomUUID(), action: "PORTAL_INVITATION_SENT", createdAt: new Date("2026-08-05T00:00:00.000Z") },
    });
    await prisma.activity.create({
      data: { organizationId: org.org.id, actorId: org.owner.id, entityType: "PORTAL_USER", entityId: randomUUID(), action: "PORTAL_INVITATION_SENT", createdAt: new Date("2026-08-06T00:00:00.000Z") },
    });
    await prisma.activity.create({
      data: { organizationId: org.org.id, actorId: null, entityType: "PORTAL_USER", entityId: randomUUID(), action: "PORTAL_INVITATION_ACCEPTED", createdAt: new Date("2026-08-06T00:00:00.000Z") },
    });
  });

  afterAll(async () => {
    await prisma.activity.deleteMany({ where: { organizationId: org.org.id } });
    await prisma.portalUser.deleteMany({ where: { clientId } });
    await prisma.client.delete({ where: { id: clientId } });
    await prisma.organization.delete({ where: { id: org.org.id } });
    await prisma.user.delete({ where: { id: org.owner.id } });
  });

  const bounds = { start: new Date("2026-08-01T00:00:00.000Z"), end: new Date("2026-08-12T00:00:00.000Z") };

  it("getPortalUserGrowthSeries buckets PortalUser.createdAt by day, zero-filled", async () => {
    const series = await getPortalUserGrowthSeries(prisma, org.org.id, bounds, "day");
    const total = series.points.reduce((sum, p) => sum + p.count, 0);
    expect(total).toBe(2);
    const aug5 = series.points.find((p) => p.bucketStart.toISOString().startsWith("2026-08-05"));
    expect(aug5?.count).toBe(1);
    const aug1 = series.points.find((p) => p.bucketStart.toISOString().startsWith("2026-08-01"));
    expect(aug1?.count).toBe(0);
  });

  it("getPortalUserGrowthSeries never counts a PortalUser from a different organization", async () => {
    const { owner: otherOwner, org: otherOrg } = await createOrgWithOwner("B");
    const series = await getPortalUserGrowthSeries(prisma, otherOrg.id, bounds, "day");
    const total = series.points.reduce((sum, p) => sum + p.count, 0);
    expect(total).toBe(0);
    await prisma.organization.delete({ where: { id: otherOrg.id } });
    await prisma.user.delete({ where: { id: otherOwner.id } });
  });

  it("getPortalInvitationSeries buckets sent and accepted independently, on their own real dates", async () => {
    const series = await getPortalInvitationSeries(prisma, org.org.id, bounds, "day");
    const totalSent = series.points.reduce((sum, p) => sum + p.created, 0);
    const totalAccepted = series.points.reduce((sum, p) => sum + p.completed, 0);
    expect(totalSent).toBe(2);
    expect(totalAccepted).toBe(1);

    const aug5 = series.points.find((p) => p.bucketStart.toISOString().startsWith("2026-08-05"));
    expect(aug5?.created).toBe(1);
    expect(aug5?.completed).toBe(0);

    const aug6 = series.points.find((p) => p.bucketStart.toISOString().startsWith("2026-08-06"));
    expect(aug6?.created).toBe(1);
    expect(aug6?.completed).toBe(1);
  });
});
