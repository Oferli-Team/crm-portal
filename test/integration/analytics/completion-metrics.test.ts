import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getInvoiceCompletionCounts } from "@/lib/analytics/queries/completion-metrics";
import { testEmail, testSlug } from "../../support/run-id";

async function createOrgWithOwner(label: string) {
  const runSuffix = randomUUID().slice(0, 8);
  const owner = await prisma.user.create({
    data: { id: randomUUID(), email: testEmail(`analytics-comp-${label}`, "test.local", runSuffix), name: `Analytics ${label}` },
  });
  const org = await prisma.organization.create({
    data: { name: `Analytics Completion Org ${label}`, slug: testSlug(`analytics-comp-${label}`, runSuffix) },
  });
  await prisma.membership.create({ data: { userId: owner.id, organizationId: org.id, role: "OWNER" } });
  return { owner, org };
}

describe("getInvoiceCompletionCounts", () => {
  let org: Awaited<ReturnType<typeof createOrgWithOwner>>;
  let clientId: string;
  let projectId: string;

  beforeAll(async () => {
    org = await createOrgWithOwner("A");
    const client = await prisma.client.create({ data: { name: "Client A", userId: org.owner.id, organizationId: org.org.id } });
    clientId = client.id;
    const project = await prisma.project.create({ data: { name: "Project A", clientId, ownerId: org.owner.id, organizationId: org.org.id } });
    projectId = project.id;

    const statuses: Array<"DRAFT" | "SENT" | "PAID" | "OVERDUE" | "CANCELLED"> = ["PAID", "PAID", "SENT", "OVERDUE", "CANCELLED", "DRAFT"];
    for (const [i, status] of statuses.entries()) {
      await prisma.invoice.create({
        data: { invoiceNumber: `INV-${i}`, status, amount: "50.00", clientId, projectId, organizationId: org.org.id },
      });
    }
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { organizationId: org.org.id } });
    await prisma.client.deleteMany({ where: { organizationId: org.org.id } }); // cascades Project
    await prisma.organization.delete({ where: { id: org.org.id } });
    await prisma.user.delete({ where: { id: org.owner.id } });
  });

  it("counts PAID and CANCELLED independently", async () => {
    const counts = await getInvoiceCompletionCounts(prisma, org.org.id);
    expect(counts.paidInvoices).toBe(2);
    expect(counts.cancelledInvoices).toBe(1);
  });

  it("a fresh organization with no invoices returns zeros", async () => {
    const { owner, org: freshOrg } = await createOrgWithOwner(`empty-${randomUUID().slice(0, 6)}`);
    const counts = await getInvoiceCompletionCounts(prisma, freshOrg.id);
    expect(counts).toEqual({ paidInvoices: 0, cancelledInvoices: 0 });
    await prisma.organization.delete({ where: { id: freshOrg.id } });
    await prisma.user.delete({ where: { id: owner.id } });
  });
});
