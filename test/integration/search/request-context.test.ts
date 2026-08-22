import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "node:crypto";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock, setMockAuthUser, setMockActiveOrganization } from "../../support/auth-mock";
import { getSearchRequestContext } from "@/lib/search/request-context";

describe("getSearchRequestContext — integration", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(() => {
    resetAuthMock();
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("no session -> 401", async () => {
    const result = await getSearchRequestContext();
    expect(result).toEqual({ ok: false, status: 401 });
  });

  it("authenticated PortalUser without a staff User -> 403", async () => {
    setMockAuthUser({ id: fixtures.portalUser.id, email: fixtures.portalUser.email });
    const result = await getSearchRequestContext();
    expect(result).toEqual({ ok: false, status: 403 });
  });

  it("authenticated staff User -> ok, with userId/organizationId/role", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await getSearchRequestContext();
    expect(result).toEqual({
      ok: true,
      userId: fixtures.owner.id,
      organizationId: fixtures.orgA.id,
      role: "OWNER",
    });
  });

  it("unknown authenticated identity (no User, no PortalUser row at all) -> 403", async () => {
    setMockAuthUser({ id: randomUUID(), email: "nobody@example.com" });
    const result = await getSearchRequestContext();
    expect(result).toEqual({ ok: false, status: 403 });
  });

  it("dual identity: a User row exists for the same id as a PortalUser row -> allowed as staff", async () => {
    // Give the fixture PortalUser's id a real staff User + Membership too,
    // simulating the same auth id being usable for both identities.
    const dualId = fixtures.portalUser.id;
    const dualEmail = `dual-${randomUUID()}@example.com`;
    await prisma.user.create({ data: { id: dualId, email: dualEmail, name: "Dual Identity" } });
    await prisma.membership.create({ data: { userId: dualId, organizationId: fixtures.orgA.id, role: "MEMBER" } });

    try {
      setMockAuthUser({ id: dualId, email: dualEmail });
      setMockActiveOrganization(fixtures.orgA.id);
      const result = await getSearchRequestContext();
      expect(result).toEqual({ ok: true, userId: dualId, organizationId: fixtures.orgA.id, role: "MEMBER" });
    } finally {
      await prisma.membership.deleteMany({ where: { userId: dualId } });
      await prisma.user.delete({ where: { id: dualId } });
    }
  });

  it("a staff User with no Membership at all -> 403, never auto-provisioned", async () => {
    const orphanId = randomUUID();
    const orphanEmail = `orphan-${randomUUID()}@example.com`;
    await prisma.user.create({ data: { id: orphanId, email: orphanEmail, name: "Orphan Staff" } });

    try {
      setMockAuthUser({ id: orphanId, email: orphanEmail });
      const result = await getSearchRequestContext();
      expect(result).toEqual({ ok: false, status: 403 });

      // The real assertion: no Organization/Membership was silently created as a side effect.
      const memberships = await prisma.membership.findMany({ where: { userId: orphanId } });
      expect(memberships).toHaveLength(0);
    } finally {
      await prisma.user.delete({ where: { id: orphanId } });
    }
  });

  it("no cookie set: falls back to the user's OWNER membership, never auto-provisions a new one", async () => {
    setMockAuthUser({ id: fixtures.owner.id, email: fixtures.owner.email });
    // Deliberately no setMockActiveOrganization call.
    const result = await getSearchRequestContext();
    expect(result).toEqual({
      ok: true,
      userId: fixtures.owner.id,
      organizationId: fixtures.orgA.id,
      role: "OWNER",
    });

    const orgCountForOwner = await prisma.membership.count({ where: { userId: fixtures.owner.id } });
    expect(orgCountForOwner).toBe(1); // still exactly the one seeded membership
  });

  it("a cookie naming an org the user isn't a member of falls back rather than trusting the cookie", async () => {
    setMockAuthUser({ id: fixtures.owner.id, email: fixtures.owner.email });
    setMockActiveOrganization(fixtures.orgB.id); // owner has no Membership in orgB
    const result = await getSearchRequestContext();
    expect(result).toEqual({
      ok: true,
      userId: fixtures.owner.id,
      organizationId: fixtures.orgA.id, // falls back to the real OWNER membership, not orgB
      role: "OWNER",
    });
  });

  it("a valid cookie for a non-OWNER membership is honored", async () => {
    actAs(fixtures.member, fixtures.orgA.id);
    const result = await getSearchRequestContext();
    expect(result).toEqual({
      ok: true,
      userId: fixtures.member.id,
      organizationId: fixtures.orgA.id,
      role: "MEMBER",
    });
  });
});
