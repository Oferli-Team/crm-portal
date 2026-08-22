import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { ensureDemoOrganization } from "../../../prisma/seed-organization";
import { seedCollaborationDemo } from "../../../prisma/seed-collaboration";
import { testEmail, testSlug } from "../../support/run-id";

/**
 * Sale-Ready Phase E, S1.1 (P1). Regression coverage for
 * prisma/seed-collaboration.ts against the real PGlite-backed database —
 * in particular the exact bug this stage's own review caught before it
 * shipped: the MENTIONED notification's own `entityType` must be
 * `"COMMENT"` (matching the real dispatch pipeline's convention), not the
 * comment's parent `"PROJECT"`, and the seeded invoice/comment ids referenced
 * by each notification's `entityId` must be the real rows this same call
 * created, not off-by-one placeholders.
 */
describe("prisma/seed-collaboration.ts", () => {
  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { organizationId: { in: createdOrgIds } } });
    await prisma.commentMention.deleteMany({ where: { comment: { organizationId: { in: createdOrgIds } } } });
    await prisma.comment.deleteMany({ where: { organizationId: { in: createdOrgIds } } });
    await prisma.invoice.deleteMany({ where: { organizationId: { in: createdOrgIds } } });
    await prisma.project.deleteMany({ where: { organizationId: { in: createdOrgIds } } });
    await prisma.client.deleteMany({ where: { organizationId: { in: createdOrgIds } } });
    await prisma.membership.deleteMany({ where: { organizationId: { in: createdOrgIds } } });
    await prisma.subscription.deleteMany({ where: { organizationId: { in: createdOrgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  async function createUser(label: string, name: string) {
    const user = await prisma.user.create({
      data: { id: randomUUID(), email: testEmail(`seed-collab-${label}`, "test.local"), name },
    });
    createdUserIds.push(user.id);
    return user;
  }

  it("seeds two connected comments (with a real mention) and two correctly-shaped notifications", async () => {
    const owner = await createUser("owner", "Test Owner");
    const member = await createUser("member", "Test Member");
    const organizationId = await ensureDemoOrganization(prisma, owner.id, {
      name: "Seed Collab Org",
      slug: testSlug("seed-collab-org"),
    });
    createdOrgIds.push(organizationId);

    const client = await prisma.client.create({
      data: { name: "Collab Test Client", userId: owner.id, organizationId },
    });
    const project = await prisma.project.create({
      data: { name: "Collab Test Project", status: "IN_PROGRESS", clientId: client.id, ownerId: owner.id, organizationId },
    });
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: "INV-TEST-1",
        amount: "100.00",
        status: "PAID",
        projectId: project.id,
        clientId: client.id,
        organizationId,
      },
    });

    await seedCollaborationDemo(prisma, {
      organizationId,
      ownerId: owner.id,
      ownerName: owner.name,
      memberId: member.id,
      memberName: member.name,
      projectId: project.id,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
    });

    const comments = await prisma.comment.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" } });
    expect(comments).toHaveLength(2);
    expect(comments[0].entityType).toBe("PROJECT");
    expect(comments[0].entityId).toBe(project.id);
    expect(comments[0].body).toContain(`@[${member.name}](user:${member.id})`);

    const mentions = await prisma.commentMention.findMany({ where: { commentId: comments[0].id } });
    expect(mentions).toHaveLength(1);
    expect(mentions[0].userId).toBe(member.id);

    const notifications = await prisma.notification.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" } });
    expect(notifications).toHaveLength(2);

    const mentioned = notifications.find((n) => n.type === "MENTIONED");
    expect(mentioned?.recipientId).toBe(member.id);
    // The exact bug this stage's own review caught: entityType must be
    // COMMENT (matching the real dispatch pipeline), not PROJECT.
    expect(mentioned?.entityType).toBe("COMMENT");
    expect(mentioned?.entityId).toBe(comments[0].id);
    expect(mentioned?.metadata).toMatchObject({ parentEntityType: "PROJECT", parentEntityId: project.id });

    const invoiceNotification = notifications.find((n) => n.type === "INVOICE_STATUS_CHANGED");
    expect(invoiceNotification?.recipientId).toBe(owner.id);
    expect(invoiceNotification?.entityId).toBe(invoice.id);
    expect(invoiceNotification?.metadata).toMatchObject({ invoiceNumber: invoice.invoiceNumber, to: "PAID" });
  });

  it("is idempotent — a second call for an organization that already has comments creates no duplicates", async () => {
    const owner = await createUser("owner-2", "Test Owner 2");
    const member = await createUser("member-2", "Test Member 2");
    const organizationId = await ensureDemoOrganization(prisma, owner.id, {
      name: "Seed Collab Org 2",
      slug: testSlug("seed-collab-org-2"),
    });
    createdOrgIds.push(organizationId);

    const client = await prisma.client.create({
      data: { name: "Collab Test Client 2", userId: owner.id, organizationId },
    });
    const project = await prisma.project.create({
      data: { name: "Collab Test Project 2", status: "IN_PROGRESS", clientId: client.id, ownerId: owner.id, organizationId },
    });
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: "INV-TEST-2",
        amount: "100.00",
        status: "PAID",
        projectId: project.id,
        clientId: client.id,
        organizationId,
      },
    });

    const seedOnce = () =>
      seedCollaborationDemo(prisma, {
        organizationId,
        ownerId: owner.id,
        ownerName: owner.name,
        memberId: member.id,
        memberName: member.name,
        projectId: project.id,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
      });

    await seedOnce();
    await seedOnce();

    expect(await prisma.comment.count({ where: { organizationId } })).toBe(2);
    expect(await prisma.notification.count({ where: { organizationId } })).toBe(2);
  });
});
