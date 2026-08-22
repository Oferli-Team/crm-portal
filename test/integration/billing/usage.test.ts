import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getOrganizationUsage } from "@/lib/billing/usage";
import { testEmail, testSlug } from "../../support/run-id";

async function createOrgWithOwner(label: string) {
  const runSuffix = randomUUID().slice(0, 8);
  const owner = await prisma.user.create({
    data: { id: randomUUID(), email: testEmail(`billing-usage-${label}`, "test.local", runSuffix), name: `Usage ${label}` },
  });
  const org = await prisma.organization.create({
    data: { name: `Usage Org ${label}`, slug: testSlug(`billing-usage-${label}`, runSuffix) },
  });
  await prisma.membership.create({ data: { userId: owner.id, organizationId: org.id, role: "OWNER" } });
  return { owner, org };
}

describe("getOrganizationUsage", () => {
  let orgA: Awaited<ReturnType<typeof createOrgWithOwner>>;
  let orgB: Awaited<ReturnType<typeof createOrgWithOwner>>;

  beforeAll(async () => {
    orgA = await createOrgWithOwner("A");
    orgB = await createOrgWithOwner("B");
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.org.id, orgB.org.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [orgA.owner.id, orgB.owner.id] } } });
  });

  afterEach(async () => {
    await prisma.attachment.deleteMany({ where: { organizationId: { in: [orgA.org.id, orgB.org.id] } } });
    await prisma.client.deleteMany({ where: { organizationId: { in: [orgA.org.id, orgB.org.id] } } });
  });

  it("counts are scoped by organization — org A's usage never includes org B's rows", async () => {
    await prisma.client.create({ data: { name: "A Client 1", userId: orgA.owner.id, organizationId: orgA.org.id } });
    await prisma.client.create({ data: { name: "A Client 2", userId: orgA.owner.id, organizationId: orgA.org.id } });
    await prisma.client.create({ data: { name: "B Client 1", userId: orgB.owner.id, organizationId: orgB.org.id } });

    const usageA = await getOrganizationUsage(prisma, orgA.org.id);
    const usageB = await getOrganizationUsage(prisma, orgB.org.id);

    expect(usageA.clients).toBe(2);
    expect(usageB.clients).toBe(1);
  });

  it("members counts real Membership rows only", async () => {
    const usage = await getOrganizationUsage(prisma, orgA.org.id);
    expect(usage.members).toBe(1); // just the owner, seeded in beforeAll
  });

  it("adding a second Membership increases the members count", async () => {
    const secondUser = await prisma.user.create({
      data: { id: randomUUID(), email: testEmail("billing-usage-second-member", "test.local", randomUUID().slice(0, 8)), name: "Second Member" },
    });
    await prisma.membership.create({ data: { userId: secondUser.id, organizationId: orgA.org.id, role: "MEMBER" } });

    const usage = await getOrganizationUsage(prisma, orgA.org.id);
    expect(usage.members).toBe(2);

    await prisma.membership.delete({ where: { userId_organizationId: { userId: secondUser.id, organizationId: orgA.org.id } } });
    await prisma.user.delete({ where: { id: secondUser.id } });
  });

  it("storage sums Attachment.sizeBytes for the org, ignoring other orgs", async () => {
    await prisma.attachment.create({
      data: {
        organizationId: orgA.org.id,
        entityType: "CLIENT",
        entityId: randomUUID(),
        storageBucket: "attachments",
        storagePath: `test/${randomUUID()}`,
        originalName: "a.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1000,
      },
    });
    await prisma.attachment.create({
      data: {
        organizationId: orgA.org.id,
        entityType: "CLIENT",
        entityId: randomUUID(),
        storageBucket: "attachments",
        storagePath: `test/${randomUUID()}`,
        originalName: "b.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2500,
      },
    });
    await prisma.attachment.create({
      data: {
        organizationId: orgB.org.id,
        entityType: "CLIENT",
        entityId: randomUUID(),
        storageBucket: "attachments",
        storagePath: `test/${randomUUID()}`,
        originalName: "c.pdf",
        mimeType: "application/pdf",
        sizeBytes: 99999,
      },
    });

    const usageA = await getOrganizationUsage(prisma, orgA.org.id);
    expect(usageA.storageBytes).toBe(3500);
  });

  it("storageBytes is 0, not null/undefined, when an org has no attachments at all", async () => {
    const { owner, org } = await createOrgWithOwner(`empty-${randomUUID().slice(0, 6)}`);
    const usage = await getOrganizationUsage(prisma, org.id);
    expect(usage.storageBytes).toBe(0);
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.delete({ where: { id: owner.id } });
  });

  it("pending invitations are NOT included in the members count returned by getOrganizationUsage itself (that combination happens one layer up, in the entitlements builder)", async () => {
    await prisma.invitation.create({
      data: {
        organizationId: orgA.org.id,
        email: testEmail("billing-usage-pending-invite", "test.local", randomUUID().slice(0, 8)),
        role: "MEMBER",
        token: randomUUID(),
        status: "PENDING",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        invitedById: orgA.owner.id,
      },
    });

    const usage = await getOrganizationUsage(prisma, orgA.org.id);
    expect(usage.members).toBe(1); // unchanged — the pending invitation is not a Membership row

    await prisma.invitation.deleteMany({ where: { organizationId: orgA.org.id } });
  });

  it("portal users are never counted anywhere in getOrganizationUsage's output (deliberately unlimited, never seat-scoped)", async () => {
    const client = await prisma.client.create({ data: { name: "Portal Host Client", userId: orgA.owner.id, organizationId: orgA.org.id } });
    await prisma.portalUser.create({
      data: { id: randomUUID(), clientId: client.id, email: testEmail("billing-usage-portal", "test.local", randomUUID().slice(0, 8)), name: "Portal User" },
    });

    const usage = await getOrganizationUsage(prisma, orgA.org.id);
    // members is unaffected — portal users are never Membership rows.
    expect(usage.members).toBe(1);
    expect(Object.keys(usage)).not.toContain("portalUsers");

    await prisma.portalUser.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
  });
});
