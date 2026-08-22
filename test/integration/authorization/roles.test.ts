import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { inviteMemberAction } from "@/app/(dashboard)/team/actions";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { testEmail } from "../../support/run-id";
import { TEST_EMAIL_DOMAIN } from "../../support/env";

// Exercises the REAL, unmodified inviteMemberAction — only Supabase Auth
// (auth.getUser()) and next/headers' cookies() are mocked (see
// test/integration/setup-mocks.ts); the permission check, the Prisma
// upsert, and the Activity write inside it all run for real.

function inviteForm(email: string, role: "ADMIN" | "MEMBER" = "MEMBER"): FormData {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("role", role);
  return fd;
}

describe("membership role permissions — inviteMemberAction", () => {
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

  it("OWNER can invite a member", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const email = testEmail("invited-by-owner", TEST_EMAIL_DOMAIN, fixtures.runId);

    const result = await inviteMemberAction({ error: null }, inviteForm(email));

    expect(result.error).toBeNull();
    const invitation = await prisma.invitation.findFirst({ where: { email, organizationId: fixtures.orgA.id } });
    expect(invitation).not.toBeNull();
    expect(invitation?.status).toBe("PENDING");

    await prisma.invitation.deleteMany({ where: { email } });
  });

  it("ADMIN can invite a member", async () => {
    actAs(fixtures.admin, fixtures.orgA.id);
    const email = testEmail("invited-by-admin", TEST_EMAIL_DOMAIN, fixtures.runId);

    const result = await inviteMemberAction({ error: null }, inviteForm(email));

    expect(result.error).toBeNull();
    const invitation = await prisma.invitation.findFirst({ where: { email, organizationId: fixtures.orgA.id } });
    expect(invitation).not.toBeNull();

    await prisma.invitation.deleteMany({ where: { email } });
  });

  it("MEMBER is rejected with a permission error, and no Invitation row is created", async () => {
    actAs(fixtures.member, fixtures.orgA.id);
    const email = testEmail("invited-by-member", TEST_EMAIL_DOMAIN, fixtures.runId);

    const result = await inviteMemberAction({ error: null }, inviteForm(email));

    expect(result.error).toBe("You don't have permission to invite members.");
    const invitation = await prisma.invitation.findFirst({ where: { email } });
    expect(invitation).toBeNull();
  });

  it("a MEMBER's rejected invite creates no Activity row either", async () => {
    actAs(fixtures.member, fixtures.orgA.id);
    const email = testEmail("invited-by-member-2", TEST_EMAIL_DOMAIN, fixtures.runId);
    const beforeCount = await prisma.activity.count({ where: { organizationId: fixtures.orgA.id } });

    await inviteMemberAction({ error: null }, inviteForm(email));

    const afterCount = await prisma.activity.count({ where: { organizationId: fixtures.orgA.id } });
    expect(afterCount).toBe(beforeCount);
  });
});
