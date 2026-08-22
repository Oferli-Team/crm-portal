import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { signup } from "@/app/(auth)/signup/actions";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { testEmail } from "../../support/run-id";
import { setMockSignUpConfig, resetAuthMock } from "../../support/auth-mock";
import { RedirectSignal } from "../../support/navigation-mock";

// SaaS Signup Foundation (Stage 6.1). supabase.auth.signUp() itself is
// mocked (see test/integration/setup-mocks.ts and setMockSignUpConfig's
// own doc comment) — everything downstream of it (getOrCreateUser,
// getOrCreateOrganizationId, createTrialSubscription) is the real
// implementation, running unmocked against the real test Postgres, the
// same "only the network-bound Supabase call is mocked" discipline every
// other integration test in this suite already follows.

function signupForm(fields: { email: string; password: string; confirmPassword?: string; organizationName: string }): FormData {
  const formData = new FormData();
  formData.set("email", fields.email);
  formData.set("password", fields.password);
  formData.set("confirmPassword", fields.confirmPassword ?? fields.password);
  formData.set("organizationName", fields.organizationName);
  return formData;
}

async function cleanupUserAndOrg(userId: string, organizationId?: string): Promise<void> {
  if (organizationId) {
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  }
  await prisma.user.deleteMany({ where: { id: userId } });
}

describe("signup — SaaS Signup Foundation (Stage 6.1)", () => {
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

  it("validates required fields before ever calling Supabase — no signUp config needed, proving it's rejected first", async () => {
    const formData = new FormData();
    formData.set("email", testEmail("signup-missing-org", "test.local"));
    formData.set("password", "correct-horse-battery-1");
    formData.set("confirmPassword", "correct-horse-battery-1");
    // organizationName intentionally omitted.

    const result = await signup({ error: null }, formData);
    expect(result.error).toBe("All fields are required.");
  });

  describe("immediate session (email confirmation disabled)", () => {
    it("creates an isolated Organization (named from the form), an OWNER Membership, and a trial Subscription — atomically, and redirects into /dashboard", async () => {
      const userId = randomUUID();
      setMockSignUpConfig({ kind: "session", id: userId });

      const email = testEmail("signup-owner", "test.local");
      const organizationName = `Acme Signup Co ${userId.slice(0, 8)}`;
      const formData = signupForm({ email, password: "correct-horse-battery-1", organizationName });

      let caught: unknown;
      try {
        await signup({ error: null }, formData);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RedirectSignal);
      expect((caught as RedirectSignal).url).toMatch(/^\/dashboard\?/);

      const user = await prisma.user.findUnique({ where: { id: userId } });
      expect(user?.email).toBe(email);

      const membership = await prisma.membership.findFirst({ where: { userId, role: "OWNER" } });
      expect(membership).not.toBeNull();

      const organization = await prisma.organization.findUnique({ where: { id: membership!.organizationId } });
      expect(organization?.name).toBe(organizationName);

      const subscription = await prisma.subscription.findUnique({ where: { organizationId: membership!.organizationId } });
      expect(subscription?.status).toBe("TRIALING");

      await cleanupUserAndOrg(userId, membership!.organizationId);
    });

    it("owner permissions: the signer-upper holds OWNER, and a second, independent signup gets its own separate OWNER membership in its own org", async () => {
      const userIdA = randomUUID();
      setMockSignUpConfig({ kind: "session", id: userIdA });
      const emailA = testEmail("signup-owner-a", "test.local");
      await expect(
        signup({ error: null }, signupForm({ email: emailA, password: "correct-horse-battery-1", organizationName: `Org A ${userIdA.slice(0, 8)}` })),
      ).rejects.toBeInstanceOf(RedirectSignal);

      const userIdB = randomUUID();
      setMockSignUpConfig({ kind: "session", id: userIdB });
      const emailB = testEmail("signup-owner-b", "test.local");
      await expect(
        signup({ error: null }, signupForm({ email: emailB, password: "correct-horse-battery-1", organizationName: `Org B ${userIdB.slice(0, 8)}` })),
      ).rejects.toBeInstanceOf(RedirectSignal);

      const membershipA = await prisma.membership.findFirstOrThrow({ where: { userId: userIdA } });
      const membershipB = await prisma.membership.findFirstOrThrow({ where: { userId: userIdB } });

      expect(membershipA.role).toBe("OWNER");
      expect(membershipB.role).toBe("OWNER");
      expect(membershipA.organizationId).not.toBe(membershipB.organizationId);

      // Cross-check: A holds no membership at all in B's organization, and
      // vice versa — two independent tenants, not a shared one.
      const crossA = await prisma.membership.findUnique({
        where: { userId_organizationId: { userId: userIdA, organizationId: membershipB.organizationId } },
      });
      const crossB = await prisma.membership.findUnique({
        where: { userId_organizationId: { userId: userIdB, organizationId: membershipA.organizationId } },
      });
      expect(crossA).toBeNull();
      expect(crossB).toBeNull();

      await cleanupUserAndOrg(userIdA, membershipA.organizationId);
      await cleanupUserAndOrg(userIdB, membershipB.organizationId);
    });

    it("existing organizations cannot be reached by a new signup: the new OWNER has no Membership in any pre-existing organization", async () => {
      const userId = randomUUID();
      setMockSignUpConfig({ kind: "session", id: userId });
      const email = testEmail("signup-isolated", "test.local");
      const formData = signupForm({ email, password: "correct-horse-battery-1", organizationName: `Isolated Co ${userId.slice(0, 8)}` });

      await expect(signup({ error: null }, formData)).rejects.toBeInstanceOf(RedirectSignal);

      const memberships = await prisma.membership.findMany({ where: { userId } });
      expect(memberships).toHaveLength(1);
      expect(memberships[0].organizationId).not.toBe(fixtures.orgA.id);
      expect(memberships[0].organizationId).not.toBe(fixtures.orgB.id);

      // Also: the pre-existing organizations' own owners are completely
      // unaffected — this signup never touched their membership rows.
      const orgAOwnerMembership = await prisma.membership.findUnique({
        where: { userId_organizationId: { userId: fixtures.owner.id, organizationId: fixtures.orgA.id } },
      });
      expect(orgAOwnerMembership?.role).toBe("OWNER");

      await cleanupUserAndOrg(userId, memberships[0].organizationId);
    });
  });

  describe("duplicate email handling", () => {
    it("surfaces Supabase's rejection message and creates no User, Organization, or Membership row", async () => {
      const email = testEmail("signup-duplicate", "test.local");
      setMockSignUpConfig({ kind: "error", message: "User already registered" });
      const organizationName = "Duplicate Attempt Co";
      const formData = signupForm({ email, password: "correct-horse-battery-1", organizationName });

      const result = await signup({ error: null }, formData);
      expect(result.error).toBe("User already registered");

      const user = await prisma.user.findUnique({ where: { email } });
      expect(user).toBeNull();

      const organization = await prisma.organization.findFirst({ where: { name: organizationName } });
      expect(organization).toBeNull();
    });
  });

  describe("email confirmation required (no session yet)", () => {
    it("does not eagerly create a User or Organization, and returns the check-your-email message", async () => {
      const userId = randomUUID();
      setMockSignUpConfig({ kind: "pending-confirmation", id: userId });
      const email = testEmail("signup-pending", "test.local");
      const organizationName = `Pending Co ${userId.slice(0, 8)}`;
      const formData = signupForm({ email, password: "correct-horse-battery-1", organizationName });

      const result = await signup({ error: null }, formData);
      expect(result.error).toBeNull();
      expect(result.message).toMatch(/check your email/i);

      const user = await prisma.user.findUnique({ where: { id: userId } });
      expect(user).toBeNull();

      const organization = await prisma.organization.findFirst({ where: { name: organizationName } });
      expect(organization).toBeNull();
    });
  });
});
