import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getClientGrowthSeries, getProjectGrowthSeries, getTaskActivitySeries, getInvoiceActivitySeries, getActivityEventsSeries } from "@/lib/analytics/queries/time-series";
import { testEmail, testSlug } from "../../support/run-id";

const NOW = new Date("2026-08-12T15:30:00.000Z");

async function createOrgWithOwner(label: string) {
  const runSuffix = randomUUID().slice(0, 8);
  const owner = await prisma.user.create({
    data: { id: randomUUID(), email: testEmail(`analytics-ts-${label}`, "test.local", runSuffix), name: `Analytics ${label}` },
  });
  const org = await prisma.organization.create({
    data: { name: `Analytics Series Org ${label}`, slug: testSlug(`analytics-ts-${label}`, runSuffix) },
  });
  await prisma.membership.create({ data: { userId: owner.id, organizationId: org.id, role: "OWNER" } });
  return { owner, org };
}

describe("time-series queries", () => {
  let org: Awaited<ReturnType<typeof createOrgWithOwner>>;
  let clientId: string;
  let projectId: string;

  beforeAll(async () => {
    org = await createOrgWithOwner("A");

    // Clients: one on Aug 5, two on Aug 10, one clearly outside the window (Jul 1).
    await prisma.client.create({ data: { name: "C1", userId: org.owner.id, organizationId: org.org.id, createdAt: new Date("2026-08-05T10:00:00.000Z") } });
    await prisma.client.create({ data: { name: "C2", userId: org.owner.id, organizationId: org.org.id, createdAt: new Date("2026-08-10T09:00:00.000Z") } });
    await prisma.client.create({ data: { name: "C3", userId: org.owner.id, organizationId: org.org.id, createdAt: new Date("2026-08-10T20:00:00.000Z") } });
    await prisma.client.create({ data: { name: "C-old", userId: org.owner.id, organizationId: org.org.id, createdAt: new Date("2026-07-01T00:00:00.000Z") } });

    // Explicit createdAt far outside every test window below — this row only
    // exists to own the Project/Invoice fixtures, never to be counted itself.
    const clientRow = await prisma.client.create({
      data: { name: "C-parent", userId: org.owner.id, organizationId: org.org.id, createdAt: new Date("2020-01-01T00:00:00.000Z") },
    });
    clientId = clientRow.id;
    const project = await prisma.project.create({ data: { name: "P1", clientId, ownerId: org.owner.id, organizationId: org.org.id, createdAt: new Date("2026-08-06T00:00:00.000Z") } });
    projectId = project.id;

    // Tasks: created Aug 5, one completed Aug 7 (different bucket than creation).
    await prisma.task.create({ data: { title: "T1", projectId, organizationId: org.org.id, createdAt: new Date("2026-08-05T00:00:00.000Z"), status: "DONE", completedAt: new Date("2026-08-07T00:00:00.000Z") } });
    await prisma.task.create({ data: { title: "T2", projectId, organizationId: org.org.id, createdAt: new Date("2026-08-05T00:00:00.000Z"), status: "TODO" } });

    // Invoices: created Aug 6, one paid Aug 9.
    await prisma.invoice.create({ data: { invoiceNumber: "INV-1", amount: "10.00", clientId, projectId, organizationId: org.org.id, createdAt: new Date("2026-08-06T00:00:00.000Z"), status: "PAID", paidAt: new Date("2026-08-09T00:00:00.000Z") } });
    await prisma.invoice.create({ data: { invoiceNumber: "INV-2", amount: "10.00", clientId, projectId, organizationId: org.org.id, createdAt: new Date("2026-08-06T00:00:00.000Z"), status: "SENT" } });

    // Activity: two on Aug 10.
    await prisma.activity.create({ data: { organizationId: org.org.id, actorId: org.owner.id, entityType: "CLIENT", entityId: randomUUID(), action: "CREATED", createdAt: new Date("2026-08-10T05:00:00.000Z") } });
    await prisma.activity.create({ data: { organizationId: org.org.id, actorId: org.owner.id, entityType: "CLIENT", entityId: randomUUID(), action: "CREATED", createdAt: new Date("2026-08-10T06:00:00.000Z") } });
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { organizationId: org.org.id } });
    await prisma.client.deleteMany({ where: { organizationId: org.org.id } }); // cascades Project -> Task
    await prisma.organization.delete({ where: { id: org.org.id } });
    await prisma.user.delete({ where: { id: org.owner.id } });
  });

  const bounds = { start: new Date("2026-08-04T00:00:00.000Z"), end: new Date("2026-08-11T00:00:00.000Z") };

  it("getClientGrowthSeries buckets by day, fills zero-activity days, and excludes rows outside the window", async () => {
    const series = await getClientGrowthSeries(prisma, org.org.id, bounds, "day");
    expect(series.unit).toBe("day");
    // 7-day window from Aug 4 -> Aug 11 (exclusive-ish via generate_series inclusive end) — expect at least 7 buckets.
    expect(series.points.length).toBeGreaterThanOrEqual(7);

    const totalCount = series.points.reduce((sum, p) => sum + p.count, 0);
    expect(totalCount).toBe(3); // C1 (Aug 5) + C2 + C3 (Aug 10) — never C-old (Jul 1)

    const aug10 = series.points.find((p) => p.bucketStart.toISOString().startsWith("2026-08-10"));
    expect(aug10?.count).toBe(2); // C2 + C3, same day, different hours

    const aug4 = series.points.find((p) => p.bucketStart.toISOString().startsWith("2026-08-04"));
    expect(aug4?.count).toBe(0); // a real zero point, not a gap
  });

  it("getProjectGrowthSeries counts the one seeded project on its real creation day", async () => {
    const series = await getProjectGrowthSeries(prisma, org.org.id, bounds, "day");
    const total = series.points.reduce((sum, p) => sum + p.count, 0);
    expect(total).toBe(1);
    const aug6 = series.points.find((p) => p.bucketStart.toISOString().startsWith("2026-08-06"));
    expect(aug6?.count).toBe(1);
  });

  it("getTaskActivitySeries buckets created and completed independently, on their own real dates", async () => {
    const series = await getTaskActivitySeries(prisma, org.org.id, bounds, "day");
    const totalCreated = series.points.reduce((sum, p) => sum + p.created, 0);
    const totalCompleted = series.points.reduce((sum, p) => sum + p.completed, 0);
    expect(totalCreated).toBe(2); // T1 + T2, both created Aug 5
    expect(totalCompleted).toBe(1); // only T1, completed Aug 7

    const aug5 = series.points.find((p) => p.bucketStart.toISOString().startsWith("2026-08-05"));
    expect(aug5?.created).toBe(2);
    expect(aug5?.completed).toBe(0); // T1 wasn't completed until Aug 7

    const aug7 = series.points.find((p) => p.bucketStart.toISOString().startsWith("2026-08-07"));
    expect(aug7?.created).toBe(0);
    expect(aug7?.completed).toBe(1);
  });

  it("getInvoiceActivitySeries buckets created and paid independently", async () => {
    const series = await getInvoiceActivitySeries(prisma, org.org.id, bounds, "day");
    const totalCreated = series.points.reduce((sum, p) => sum + p.created, 0);
    const totalCompleted = series.points.reduce((sum, p) => sum + p.completed, 0);
    expect(totalCreated).toBe(2);
    expect(totalCompleted).toBe(1);
  });

  it("getActivityEventsSeries counts real Activity rows per day", async () => {
    const series = await getActivityEventsSeries(prisma, org.org.id, bounds, "day");
    const aug10 = series.points.find((p) => p.bucketStart.toISOString().startsWith("2026-08-10"));
    expect(aug10?.count).toBe(2);
  });

  it("is scoped to the given organization only", async () => {
    const { owner: otherOwner, org: otherOrg } = await createOrgWithOwner("B");
    const series = await getClientGrowthSeries(prisma, otherOrg.id, bounds, "day");
    const total = series.points.reduce((sum, p) => sum + p.count, 0);
    expect(total).toBe(0);
    await prisma.organization.delete({ where: { id: otherOrg.id } });
    await prisma.user.delete({ where: { id: otherOwner.id } });
  });

  it("supports hourly and weekly bucket units without erroring", async () => {
    const hourly = await getClientGrowthSeries(prisma, org.org.id, { start: new Date("2026-08-10T00:00:00.000Z"), end: new Date("2026-08-11T00:00:00.000Z") }, "hour");
    expect(hourly.unit).toBe("hour");
    expect(hourly.points.length).toBeGreaterThanOrEqual(24);

    const weekly = await getClientGrowthSeries(prisma, org.org.id, { start: new Date("2026-07-01T00:00:00.000Z"), end: NOW }, "week");
    expect(weekly.unit).toBe("week");
    expect(weekly.points.length).toBeGreaterThan(0);
  });
});
