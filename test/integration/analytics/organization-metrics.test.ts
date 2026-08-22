import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getOrganizationMetrics } from "@/lib/analytics/queries/organization-metrics";
import { testEmail, testSlug } from "../../support/run-id";

async function createOrgWithOwner(label: string) {
  const runSuffix = randomUUID().slice(0, 8);
  const owner = await prisma.user.create({
    data: { id: randomUUID(), email: testEmail(`analytics-org-${label}`, "test.local", runSuffix), name: `Analytics ${label}` },
  });
  const org = await prisma.organization.create({
    data: { name: `Analytics Org ${label}`, slug: testSlug(`analytics-org-${label}`, runSuffix) },
  });
  await prisma.membership.create({ data: { userId: owner.id, organizationId: org.id, role: "OWNER" } });
  return { owner, org };
}

describe("getOrganizationMetrics", () => {
  let orgA: Awaited<ReturnType<typeof createOrgWithOwner>>;
  let orgB: Awaited<ReturnType<typeof createOrgWithOwner>>;
  let clientA: { id: string };

  beforeAll(async () => {
    orgA = await createOrgWithOwner("A");
    orgB = await createOrgWithOwner("B");

    clientA = await prisma.client.create({ data: { name: "Client A1", userId: orgA.owner.id, organizationId: orgA.org.id } });
    await prisma.client.create({ data: { name: "Client A2", userId: orgA.owner.id, organizationId: orgA.org.id } });
    await prisma.client.create({ data: { name: "Client B1", userId: orgB.owner.id, organizationId: orgB.org.id } });

    const projectA = await prisma.project.create({
      data: { name: "Project A1", clientId: clientA.id, ownerId: orgA.owner.id, organizationId: orgA.org.id },
    });

    await prisma.task.create({ data: { title: "Task 1", status: "DONE", projectId: projectA.id, organizationId: orgA.org.id } });
    await prisma.task.create({ data: { title: "Task 2", status: "TODO", projectId: projectA.id, organizationId: orgA.org.id } });
    await prisma.task.create({ data: { title: "Task 3", status: "IN_PROGRESS", projectId: projectA.id, organizationId: orgA.org.id } });
    await prisma.task.create({ data: { title: "Task 4", status: "IN_REVIEW", projectId: projectA.id, organizationId: orgA.org.id } });

    await prisma.invoice.create({
      data: { invoiceNumber: "INV-A-1", amount: "100.00", clientId: clientA.id, projectId: projectA.id, organizationId: orgA.org.id },
    });

    await prisma.attachment.create({
      data: {
        organizationId: orgA.org.id,
        entityType: "CLIENT",
        entityId: clientA.id,
        storageBucket: "attachments",
        storagePath: `test/${randomUUID()}`,
        originalName: "a.pdf",
        mimeType: "application/pdf",
        sizeBytes: 100,
      },
    });
  });

  afterAll(async () => {
    const orgIds = [orgA.org.id, orgB.org.id];
    await prisma.invoice.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.client.deleteMany({ where: { organizationId: { in: orgIds } } }); // cascades Project -> Task
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [orgA.owner.id, orgB.owner.id] } } });
  });

  it("counts totals scoped to the organization", async () => {
    const metrics = await getOrganizationMetrics(prisma, orgA.org.id);
    expect(metrics.totalClients).toBe(2);
    expect(metrics.totalProjects).toBe(1);
    expect(metrics.totalTasks).toBe(4);
    expect(metrics.totalInvoices).toBe(1);
    expect(metrics.totalMembers).toBe(1);
    expect(metrics.totalAttachments).toBe(1);
  });

  it("completedTasks counts only DONE; openTasks counts TODO/IN_PROGRESS/IN_REVIEW", async () => {
    const metrics = await getOrganizationMetrics(prisma, orgA.org.id);
    expect(metrics.completedTasks).toBe(1);
    expect(metrics.openTasks).toBe(3);
  });

  it("never includes another organization's rows", async () => {
    const metricsB = await getOrganizationMetrics(prisma, orgB.org.id);
    expect(metricsB.totalClients).toBe(1);
    expect(metricsB.totalProjects).toBe(0);
    expect(metricsB.totalTasks).toBe(0);
  });

  it("a brand-new organization with no data returns all zeros, never an error", async () => {
    const { owner, org } = await createOrgWithOwner(`empty-${randomUUID().slice(0, 6)}`);
    const metrics = await getOrganizationMetrics(prisma, org.id);
    expect(metrics).toEqual({
      totalClients: 0,
      totalProjects: 0,
      totalTasks: 0,
      completedTasks: 0,
      openTasks: 0,
      totalInvoices: 0,
      totalMembers: 1, // the owner's own Membership row
      totalAttachments: 0,
    });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.delete({ where: { id: owner.id } });
  });
});
