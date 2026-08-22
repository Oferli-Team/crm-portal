import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getGrowthMetrics } from "@/lib/analytics/queries/growth-metrics";
import { getTimeRangeBounds, getPreviousPeriodBounds } from "@/lib/analytics/calculations/date-ranges";
import { testEmail, testSlug } from "../../support/run-id";

const NOW = new Date("2026-08-12T15:30:00.000Z");

async function createOrgWithOwner(label: string) {
  const runSuffix = randomUUID().slice(0, 8);
  const owner = await prisma.user.create({
    data: { id: randomUUID(), email: testEmail(`analytics-growth-${label}`, "test.local", runSuffix), name: `Analytics ${label}` },
  });
  const org = await prisma.organization.create({
    data: { name: `Analytics Growth Org ${label}`, slug: testSlug(`analytics-growth-${label}`, runSuffix) },
  });
  await prisma.membership.create({ data: { userId: owner.id, organizationId: org.id, role: "OWNER" } });
  return { owner, org };
}

describe("getGrowthMetrics", () => {
  let org: Awaited<ReturnType<typeof createOrgWithOwner>>;

  beforeAll(async () => {
    org = await createOrgWithOwner("A");

    const bounds = getTimeRangeBounds("last7Days", NOW); // last 7 days: Aug 5 15:30 -> Aug 12 15:30
    const previousBounds = getPreviousPeriodBounds(bounds); // Jul 29 15:30 -> Aug 5 15:30

    // 3 clients in the current period, 1 in the previous period.
    const clientCreates = [
      new Date(bounds.start!.getTime() + 1000),
      new Date(bounds.start!.getTime() + 2000),
      new Date(bounds.start!.getTime() + 3000),
    ].map((createdAt) => prisma.client.create({ data: { name: `Growth Client ${createdAt.toISOString()}`, userId: org.owner.id, organizationId: org.org.id, createdAt } }));
    await Promise.all(clientCreates);
    await prisma.client.create({
      data: { name: "Previous period client", userId: org.owner.id, organizationId: org.org.id, createdAt: new Date(previousBounds.start!.getTime() + 1000) },
    });
    // Outside both windows entirely — must never be counted.
    await prisma.client.create({
      data: { name: "Ancient client", userId: org.owner.id, organizationId: org.org.id, createdAt: new Date("2020-01-01T00:00:00.000Z") },
    });
  });

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { organizationId: org.org.id } });
    await prisma.organization.delete({ where: { id: org.org.id } });
    await prisma.user.delete({ where: { id: org.owner.id } });
  });

  it("counts current vs previous equal-length period correctly, excluding rows outside both", async () => {
    const bounds = getTimeRangeBounds("last7Days", NOW);
    const previousBounds = getPreviousPeriodBounds(bounds);
    const growth = await getGrowthMetrics(prisma, org.org.id, bounds, previousBounds);

    expect(growth.clientGrowth.currentPeriodCount).toBe(3);
    expect(growth.clientGrowth.previousPeriodCount).toBe(1);
    expect(growth.clientGrowth.changePercent).toBe(200); // (3-1)/1 * 100
  });

  it("projectGrowth and taskGrowth are 0/0/null for an org with none created in either window", async () => {
    const bounds = getTimeRangeBounds("last7Days", NOW);
    const previousBounds = getPreviousPeriodBounds(bounds);
    const growth = await getGrowthMetrics(prisma, org.org.id, bounds, previousBounds);

    expect(growth.projectGrowth).toEqual({ currentPeriodCount: 0, previousPeriodCount: 0, changePercent: null });
    expect(growth.taskGrowth).toEqual({ currentPeriodCount: 0, previousPeriodCount: 0, changePercent: null });
  });

  it("is scoped to the given organization only", async () => {
    const { owner: otherOwner, org: otherOrg } = await createOrgWithOwner("B");
    const bounds = getTimeRangeBounds("last7Days", NOW);
    const previousBounds = getPreviousPeriodBounds(bounds);
    const growth = await getGrowthMetrics(prisma, otherOrg.id, bounds, previousBounds);

    expect(growth.clientGrowth.currentPeriodCount).toBe(0);

    await prisma.organization.delete({ where: { id: otherOrg.id } });
    await prisma.user.delete({ where: { id: otherOwner.id } });
  });
});
