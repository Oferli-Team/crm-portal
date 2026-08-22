import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getActivityMetrics } from "@/lib/analytics/queries/activity-metrics";
import { testEmail, testSlug } from "../../support/run-id";

const NOW = new Date("2026-08-12T15:30:00.000Z"); // Wednesday

async function createOrgWithOwner(label: string) {
  const runSuffix = randomUUID().slice(0, 8);
  const owner = await prisma.user.create({
    data: { id: randomUUID(), email: testEmail(`analytics-act-${label}`, "test.local", runSuffix), name: `Analytics ${label}` },
  });
  const org = await prisma.organization.create({
    data: { name: `Analytics Activity Org ${label}`, slug: testSlug(`analytics-act-${label}`, runSuffix) },
  });
  await prisma.membership.create({ data: { userId: owner.id, organizationId: org.id, role: "OWNER" } });
  return { owner, org };
}

async function createActivityAt(organizationId: string, actorId: string, createdAt: Date) {
  await prisma.activity.create({
    data: {
      organizationId,
      actorId,
      entityType: "CLIENT",
      entityId: randomUUID(),
      action: "CREATED",
      createdAt,
    },
  });
}

describe("getActivityMetrics", () => {
  let org: Awaited<ReturnType<typeof createOrgWithOwner>>;

  beforeAll(async () => {
    org = await createOrgWithOwner("A");

    // Today (after UTC midnight of 2026-08-12): 2 rows.
    await createActivityAt(org.org.id, org.owner.id, new Date("2026-08-12T01:00:00.000Z"));
    await createActivityAt(org.org.id, org.owner.id, new Date("2026-08-12T14:00:00.000Z"));

    // Earlier this week (Mon 2026-08-10), but before today: 1 row.
    await createActivityAt(org.org.id, org.owner.id, new Date("2026-08-10T05:00:00.000Z"));

    // Earlier this month (Aug 3), but before this week: 1 row.
    await createActivityAt(org.org.id, org.owner.id, new Date("2026-08-03T05:00:00.000Z"));

    // Last month (July): 1 row, outside all three windows.
    await createActivityAt(org.org.id, org.owner.id, new Date("2026-07-15T05:00:00.000Z"));
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: org.org.id } });
    await prisma.user.delete({ where: { id: org.owner.id } });
  });

  it("createdToday counts only rows since UTC midnight today", async () => {
    const metrics = await getActivityMetrics(prisma, org.org.id, NOW);
    expect(metrics.createdToday).toBe(2);
  });

  it("createdThisWeek counts rows since Monday 00:00 UTC, including today's", async () => {
    const metrics = await getActivityMetrics(prisma, org.org.id, NOW);
    expect(metrics.createdThisWeek).toBe(3); // today's 2 + Monday's 1
  });

  it("createdThisMonth counts rows since the 1st of the UTC month, including this week's", async () => {
    const metrics = await getActivityMetrics(prisma, org.org.id, NOW);
    expect(metrics.createdThisMonth).toBe(4); // this week's 3 + Aug 3rd's 1
  });

  it("last month's row is excluded from all three windows", async () => {
    const metrics = await getActivityMetrics(prisma, org.org.id, NOW);
    expect(metrics.createdThisMonth).toBeLessThan(5);
  });
});
