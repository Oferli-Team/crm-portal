import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { portalLogin } from "@/app/portal/login/actions";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { setMockSignInConfig, getMockAuthUser, resetAuthMock } from "../../support/auth-mock";
import { RedirectSignal, resetNavigationMock } from "../../support/navigation-mock";
import { testEmail } from "../../support/run-id";
import { TEST_EMAIL_DOMAIN } from "../../support/env";

/**
 * Portal Analytics persistence foundation (docs/analytics-architecture.md
 * §12, Slice 1). Calls the real, unmodified portalLogin Server Action
 * directly — no logic extracted purely for testability — made possible by
 * extending the existing Supabase auth mock with a one-shot
 * MockSignInConfig for supabase.auth.signInWithPassword(), the same
 * pattern MockSignUpConfig already established for signUp(). Everything
 * downstream of that one mocked call (the PortalUser/Membership lookups,
 * the analytics write) is the real implementation, running unmocked
 * against the real test Postgres.
 */
function loginForm(fields: { email: string; password?: string }): FormData {
  const formData = new FormData();
  formData.set("email", fields.email);
  formData.set("password", fields.password ?? "correct-horse-battery-staple");
  return formData;
}

describe("portalLogin — Portal Analytics persistence foundation", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(async () => {
    resetAuthMock();
    resetNavigationMock();
    await prisma.portalUser.update({ where: { id: fixtures.portalUser.id }, data: { lastLoginAt: null } });
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("a real PortalUser identity: redirects successfully and writes lastLoginAt, without provisioning any staff User/Membership", async () => {
    setMockSignInConfig({
      kind: "success",
      user: { id: fixtures.portalUser.id, email: fixtures.portalUser.email },
    });

    await expect(portalLogin({ error: null }, loginForm({ email: fixtures.portalUser.email }))).rejects.toBeInstanceOf(
      RedirectSignal,
    );

    const updated = await prisma.portalUser.findUniqueOrThrow({ where: { id: fixtures.portalUser.id } });
    expect(updated.lastLoginAt).not.toBeNull();

    // Accepting/logging in to the Client Portal must never create a staff
    // User or Membership row for this same auth id.
    const staffUser = await prisma.user.findUnique({ where: { id: fixtures.portalUser.id } });
    expect(staffUser).toBeNull();
    const membership = await prisma.membership.findFirst({ where: { userId: fixtures.portalUser.id } });
    expect(membership).toBeNull();
  });

  it("a staff-only identity (Membership, no PortalUser): redirects to /dashboard and never writes any PortalUser tracking", async () => {
    setMockSignInConfig({
      kind: "success",
      user: { id: fixtures.owner.id, email: fixtures.owner.email },
    });

    let caught: unknown;
    try {
      await portalLogin({ error: null }, loginForm({ email: fixtures.owner.email }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RedirectSignal);
    expect((caught as RedirectSignal).url).toContain("/dashboard");

    // No PortalUser row exists for the owner's id — nothing to have
    // written lastLoginAt to, and none should have been created.
    const portalUser = await prisma.portalUser.findUnique({ where: { id: fixtures.owner.id } });
    expect(portalUser).toBeNull();
  });

  it("an authenticated identity with neither PortalUser nor Membership: generic no-access error, session signed out, no tracking write", async () => {
    const strandedAuthId = randomUUID();
    const strandedEmail = testEmail("stranded", TEST_EMAIL_DOMAIN, fixtures.runId);
    setMockSignInConfig({ kind: "success", user: { id: strandedAuthId, email: strandedEmail } });

    const result = await portalLogin({ error: null }, loginForm({ email: strandedEmail }));

    expect(result.error).toBe("This account does not have Client Portal access.");

    const portalUser = await prisma.portalUser.findUnique({ where: { id: strandedAuthId } });
    expect(portalUser).toBeNull();

    // Proves the "session signed out" claim, rather than asserting it by
    // name alone — the mock's own signOut() now actually clears the
    // identity signInWithPassword() set, the same way a real Supabase
    // sign-out would.
    expect(getMockAuthUser()).toBeNull();
  });

  it("a Supabase sign-in error: existing generic error behavior is preserved, no tracking write", async () => {
    setMockSignInConfig({ kind: "error", message: "Invalid login credentials" });

    const result = await portalLogin({ error: null }, loginForm({ email: fixtures.portalUser.email }));

    expect(result.error).toBe("Invalid login credentials");

    const unchanged = await prisma.portalUser.findUniqueOrThrow({ where: { id: fixtures.portalUser.id } });
    expect(unchanged.lastLoginAt).toBeNull();
  });
});
