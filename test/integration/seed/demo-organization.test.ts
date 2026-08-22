import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { ensureDemoOrganization, ensureMembership } from "../../../prisma/seed-organization";
import { testEmail, testSlug } from "../../support/run-id";

/**
 * Sale-Ready Phase E, S1.1 (P0). Regression coverage for the exact defect
 * this stage fixed: `prisma/seed.ts` used to create every seeded Client/
 * Project/Task/Invoice with no organizationId at all, orphaned from
 * whatever organization a user's first login would go on to
 * auto-provision — so a fresh `npm run db:seed` run produced a demo login
 * that landed on an empty, disconnected workspace. `prisma/seed-
 * organization.ts` was extracted specifically so this real, non-mocked
 * behavior — against the same PGlite-backed Postgres every other
 * integration test uses — could be exercised directly, independent of
 * Supabase Auth (neither function under test touches it).
 */

describe("prisma/seed-organization.ts", () => {
  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];

  afterAll(async () => {
    await prisma.membership.deleteMany({ where: { organizationId: { in: createdOrgIds } } });
    await prisma.subscription.deleteMany({ where: { organizationId: { in: createdOrgIds } } });
    await prisma.client.deleteMany({ where: { organizationId: { in: createdOrgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  async function createUser(label: string) {
    const user = await prisma.user.create({
      data: { id: randomUUID(), email: testEmail(`seed-org-${label}`, "test.local"), name: `Seed Org ${label}` },
    });
    createdUserIds.push(user.id);
    return user;
  }

  it("ensureDemoOrganization creates a real Organization, a real OWNER Membership, and a real TRIALING Subscription", async () => {
    const owner = await createUser("owner-a");
    const organizationId = await ensureDemoOrganization(prisma, owner.id, {
      name: "Seed Test Org A",
      slug: testSlug("seed-org-a"),
    });
    createdOrgIds.push(organizationId);

    const membership = await prisma.membership.findUnique({
      where: { userId_organizationId: { userId: owner.id, organizationId } },
    });
    expect(membership?.role).toBe("OWNER");

    const subscription = await prisma.subscription.findUnique({ where: { organizationId } });
    expect(subscription?.status).toBe("TRIALING");
  });

  it("is idempotent — a second call for the same owner returns the same organizationId and never creates a duplicate Organization", async () => {
    const owner = await createUser("owner-b");
    const first = await ensureDemoOrganization(prisma, owner.id, {
      name: "Seed Test Org B",
      slug: testSlug("seed-org-b"),
    });
    createdOrgIds.push(first);

    const second = await ensureDemoOrganization(prisma, owner.id, {
      name: "Seed Test Org B (should never be applied)",
      slug: testSlug("seed-org-b-second-call"),
    });

    expect(second).toBe(first);
    expect(await prisma.organization.count({ where: { id: first } })).toBe(1);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: first } });
    expect(org.name).toBe("Seed Test Org B");
  });

  it("ensureMembership adds a real, correctly-roled teammate Membership in the SAME organization as the owner", async () => {
    const owner = await createUser("owner-c");
    const organizationId = await ensureDemoOrganization(prisma, owner.id, {
      name: "Seed Test Org C",
      slug: testSlug("seed-org-c"),
    });
    createdOrgIds.push(organizationId);

    const teammate = await createUser("member-c");
    await ensureMembership(prisma, organizationId, teammate.id, "MEMBER");

    const membership = await prisma.membership.findUnique({
      where: { userId_organizationId: { userId: teammate.id, organizationId } },
    });
    expect(membership?.role).toBe("MEMBER");
    expect(await prisma.membership.count({ where: { organizationId } })).toBe(2);
  });

  it("ensureMembership is idempotent — a repeated call for the same pair creates no duplicate row", async () => {
    const owner = await createUser("owner-d");
    const organizationId = await ensureDemoOrganization(prisma, owner.id, {
      name: "Seed Test Org D",
      slug: testSlug("seed-org-d"),
    });
    createdOrgIds.push(organizationId);
    const teammate = await createUser("member-d");

    await ensureMembership(prisma, organizationId, teammate.id, "MEMBER");
    await ensureMembership(prisma, organizationId, teammate.id, "MEMBER");

    expect(await prisma.membership.count({ where: { userId: teammate.id, organizationId } })).toBe(1);
  });

  it("tenant-owned data created under this organizationId is invisible to an unrelated organization's own scoped query — the exact regression this stage fixed", async () => {
    const ownerA = await createUser("iso-owner-a");
    const orgAId = await ensureDemoOrganization(prisma, ownerA.id, {
      name: "Seed Iso Org A",
      slug: testSlug("seed-iso-org-a"),
    });
    createdOrgIds.push(orgAId);

    const ownerB = await createUser("iso-owner-b");
    const orgBId = await ensureDemoOrganization(prisma, ownerB.id, {
      name: "Seed Iso Org B",
      slug: testSlug("seed-iso-org-b"),
    });
    createdOrgIds.push(orgBId);

    const client = await prisma.client.create({
      data: { name: "Iso Test Client", userId: ownerA.id, organizationId: orgAId },
    });

    const seenFromOrgB = await prisma.client.findFirst({ where: { id: client.id, organizationId: orgBId } });
    expect(seenFromOrgB).toBeNull();

    const seenFromOrgA = await prisma.client.findFirst({ where: { id: client.id, organizationId: orgAId } });
    expect(seenFromOrgA?.id).toBe(client.id);
  });
});
