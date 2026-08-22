import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  assertCanInviteMember,
  assertCanCreateClient,
  assertCanCreateProject,
  assertCanUploadAttachment,
  BillingLimitError,
} from "@/lib/billing/enforcement";
import { getOrganizationEntitlements } from "@/lib/billing/entitlements";
import { testEmail, testSlug } from "../../support/run-id";

async function createOrgWithSubscription(
  label: string,
  overrides: Partial<{ planKey: string; status: "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELED" | "INCOMPLETE" | "UNPAID" }> = {},
) {
  const runSuffix = randomUUID().slice(0, 8);
  const owner = await prisma.user.create({
    data: { id: randomUUID(), email: testEmail(`billing-enf-${label}`, "test.local", runSuffix), name: `Enforcement ${label}` },
  });
  const org = await prisma.organization.create({
    data: { name: `Enforcement Org ${label}`, slug: testSlug(`billing-enf-${label}`, runSuffix) },
  });
  await prisma.membership.create({ data: { userId: owner.id, organizationId: org.id, role: "OWNER" } });

  const now = new Date();
  await prisma.subscription.create({
    data: {
      organizationId: org.id,
      planKey: overrides.planKey ?? "STARTER", // maxMembers: 1, maxClients: 10, maxProjects: 20, maxStorageBytes: 500MB
      status: overrides.status ?? "ACTIVE",
      trialStartedAt: now,
      trialEndsAt: now,
    },
  });

  return { owner, org };
}

async function cleanup(orgId: string, ownerId: string) {
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.user.delete({ where: { id: ownerId } });
}

describe("assertCanInviteMember", () => {
  it("under the limit: resolves without throwing", async () => {
    // STARTER's maxMembers is 1, already filled by the owner alone — PRO
    // (maxMembers 5) is used here specifically to leave real headroom;
    // STARTER is reserved for the "at the limit" case below.
    const { owner, org } = await createOrgWithSubscription("invite-under", { planKey: "PRO" });
    await expect(assertCanInviteMember(org.id)).resolves.toBeUndefined();
    await cleanup(org.id, owner.id);
  });

  it("at the limit (STARTER: maxMembers 1, owner already fills it): throws BillingLimitError with MEMBER_LIMIT_REACHED", async () => {
    const { owner, org } = await createOrgWithSubscription("invite-at");
    let caught: unknown;
    try {
      await assertCanInviteMember(org.id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BillingLimitError);
    expect((caught as InstanceType<typeof BillingLimitError>).reasonCode).toBe("MEMBER_LIMIT_REACHED");
    await cleanup(org.id, owner.id);
  });

  it("a pending invitation alone (no second real member yet) is enough to hit the limit", async () => {
    const { owner, org } = await createOrgWithSubscription("invite-pending", { planKey: "PRO" }); // maxMembers: 5
    // Fill 4 more "slots" via pending invitations so owner(1) + 4 pending = 5 = the limit.
    for (let i = 0; i < 4; i++) {
      await prisma.invitation.create({
        data: {
          organizationId: org.id,
          email: testEmail(`billing-enf-pending-${i}`, "test.local", randomUUID().slice(0, 6)),
          role: "MEMBER",
          token: randomUUID(),
          status: "PENDING",
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          invitedById: owner.id,
        },
      });
    }
    await expect(assertCanInviteMember(org.id)).rejects.toThrow();
    await prisma.invitation.deleteMany({ where: { organizationId: org.id } });
    await cleanup(org.id, owner.id);
  });

  it("READ_ONLY access mode blocks invites even with headroom under the count limit", async () => {
    const { owner, org } = await createOrgWithSubscription("invite-readonly", { planKey: "PRO", status: "UNPAID" });
    await expect(assertCanInviteMember(org.id)).rejects.toMatchObject({ reasonCode: "READ_ONLY_ACCESS" });
    await cleanup(org.id, owner.id);
  });
});

describe("assertCanCreateClient", () => {
  it("under the limit: resolves", async () => {
    const { owner, org } = await createOrgWithSubscription("client-under");
    await expect(assertCanCreateClient(org.id)).resolves.toBeUndefined();
    await cleanup(org.id, owner.id);
  });

  it("at the limit (STARTER: maxClients 10): throws with CLIENT_LIMIT_REACHED", async () => {
    const { owner, org } = await createOrgWithSubscription("client-at");
    await prisma.client.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({ name: `Client ${i}`, userId: owner.id, organizationId: org.id })),
    });
    await expect(assertCanCreateClient(org.id)).rejects.toMatchObject({ reasonCode: "CLIENT_LIMIT_REACHED" });
    await prisma.client.deleteMany({ where: { organizationId: org.id } });
    await cleanup(org.id, owner.id);
  });

  it("legacy organization (no Subscription row) is never blocked", async () => {
    const owner = await prisma.user.create({
      data: { id: randomUUID(), email: testEmail("billing-enf-legacy-client", "test.local", randomUUID().slice(0, 8)), name: "Legacy Owner" },
    });
    const org = await prisma.organization.create({ data: { name: "Legacy Client Org", slug: testSlug("billing-enf-legacy-client", randomUUID().slice(0, 8)) } });
    await prisma.membership.create({ data: { userId: owner.id, organizationId: org.id, role: "OWNER" } });
    // Deliberately no Subscription row created — this is the legacy case.

    await prisma.client.createMany({
      data: Array.from({ length: 500 }, (_, i) => ({ name: `Legacy Client ${i}`, userId: owner.id, organizationId: org.id })),
    });
    await expect(assertCanCreateClient(org.id)).resolves.toBeUndefined();

    await prisma.client.deleteMany({ where: { organizationId: org.id } });
    await cleanup(org.id, owner.id);
  });

  it("cross-org: a caller cannot use org A's usage to authorize a write scoped to org B — passing org B's id always evaluates org B's own state", async () => {
    const orgA = await createOrgWithSubscription("cross-a");
    const orgB = await createOrgWithSubscription("cross-b");
    // Fill org A to its limit; org B stays empty.
    await prisma.client.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({ name: `A Client ${i}`, userId: orgA.owner.id, organizationId: orgA.org.id })),
    });

    await expect(assertCanCreateClient(orgA.org.id)).rejects.toThrow(); // org A is at its limit
    await expect(assertCanCreateClient(orgB.org.id)).resolves.toBeUndefined(); // org B is untouched by org A's usage

    await prisma.client.deleteMany({ where: { organizationId: orgA.org.id } });
    await cleanup(orgA.org.id, orgA.owner.id);
    await cleanup(orgB.org.id, orgB.owner.id);
  });
});

describe("assertCanCreateProject", () => {
  it("under/at the limit (STARTER: maxProjects 20)", async () => {
    const { owner, org } = await createOrgWithSubscription("project-limit");
    const client = await prisma.client.create({ data: { name: "Project Owner Client", userId: owner.id, organizationId: org.id } });

    await expect(assertCanCreateProject(org.id)).resolves.toBeUndefined();

    await prisma.project.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        name: `Project ${i}`,
        clientId: client.id,
        ownerId: owner.id,
        organizationId: org.id,
        status: "PLANNING",
      })),
    });
    await expect(assertCanCreateProject(org.id)).rejects.toMatchObject({ reasonCode: "PROJECT_LIMIT_REACHED" });

    await prisma.project.deleteMany({ where: { organizationId: org.id } });
    await prisma.client.delete({ where: { id: client.id } });
    await cleanup(org.id, owner.id);
  });
});

describe("assertCanUploadAttachment", () => {
  it("under the storage limit: resolves", async () => {
    const { owner, org } = await createOrgWithSubscription("upload-under"); // STARTER: 500MB
    await expect(assertCanUploadAttachment(org.id, 1024)).resolves.toBeUndefined();
    await cleanup(org.id, owner.id);
  });

  it("an upload that would cross the limit is rejected, even though current usage is under it", async () => {
    const { owner, org } = await createOrgWithSubscription("upload-cross");
    const maxBytes = 500 * 1024 * 1024;
    await prisma.attachment.create({
      data: {
        organizationId: org.id,
        entityType: "CLIENT",
        entityId: randomUUID(),
        storageBucket: "attachments",
        storagePath: `test/${randomUUID()}`,
        originalName: "big.pdf",
        mimeType: "application/pdf",
        sizeBytes: maxBytes - 100,
      },
    });

    await expect(assertCanUploadAttachment(org.id, 50)).resolves.toBeUndefined(); // fits
    await expect(assertCanUploadAttachment(org.id, 200)).rejects.toMatchObject({ reasonCode: "STORAGE_LIMIT_REACHED" }); // would cross

    await prisma.attachment.deleteMany({ where: { organizationId: org.id } });
    await cleanup(org.id, owner.id);
  });
});

describe("existing reads/updates/deletes are never affected by any billing check", () => {
  it("reading, updating, and deleting an existing Client succeeds even when the org is at/over its client limit", async () => {
    const { owner, org } = await createOrgWithSubscription("readwrite-unaffected");
    await prisma.client.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({ name: `RW Client ${i}`, userId: owner.id, organizationId: org.id })),
    });
    const existing = await prisma.client.findFirstOrThrow({ where: { organizationId: org.id } });

    // Reading.
    const read = await prisma.client.findUnique({ where: { id: existing.id } });
    expect(read).not.toBeNull();

    // Updating (no billing check anywhere on the edit path in this stage).
    const updated = await prisma.client.update({ where: { id: existing.id }, data: { notes: "updated freely" } });
    expect(updated.notes).toBe("updated freely");

    // Deleting.
    await prisma.client.delete({ where: { id: existing.id } });
    const afterDelete = await prisma.client.findUnique({ where: { id: existing.id } });
    expect(afterDelete).toBeNull();

    await prisma.client.deleteMany({ where: { organizationId: org.id } });
    await cleanup(org.id, owner.id);
  });
});

describe("getOrganizationEntitlements — cross-org isolation at the top-level entry point", () => {
  it("two different organizationIds always resolve independently, never bleeding usage/limits across each other", async () => {
    const orgA = await createOrgWithSubscription("entitlements-a", { planKey: "STARTER" });
    const orgB = await createOrgWithSubscription("entitlements-b", { planKey: "PRO" });

    const entitlementsA = await getOrganizationEntitlements(orgA.org.id);
    const entitlementsB = await getOrganizationEntitlements(orgB.org.id);

    expect(entitlementsA.planKey).toBe("STARTER");
    expect(entitlementsB.planKey).toBe("PRO");
    expect(entitlementsA.maxClients).toBe(10);
    expect(entitlementsB.maxClients).toBeNull();

    await cleanup(orgA.org.id, orgA.owner.id);
    await cleanup(orgB.org.id, orgB.owner.id);
  });
});
