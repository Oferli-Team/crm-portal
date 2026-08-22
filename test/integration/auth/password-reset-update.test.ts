import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// See password-reset-request.test.ts's own doc comment for why.
vi.mock("server-only", () => ({}));

const { resetPassword, signOutAndGoToLogin } = await import("@/app/(auth)/reset-password/actions");
const { resetPortalPassword, signOutAndGoToPortalLogin } = await import("@/app/portal/reset-password/actions");
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { RedirectSignal, getNavigationCalls, resetNavigationMock } from "../../support/navigation-mock";

// Sale-Ready Phase B, PR1 (Password Recovery). resetPasswordCore is
// identity-agnostic (see its own doc comment) — actAs() (the existing
// "log in as" helper every other integration test already uses) is
// exactly what stands in for the session a real /auth/confirm visit would
// have established; the mocked auth.updateUser() (test/integration/
// setup-mocks.ts) reports success unconditionally, matching the same
// "TEST_MODE has no real password to check" reasoning its own real
// TEST_MODE stub (src/lib/supabase/server.ts) follows.

function resetForm(password: string, confirmPassword = password): FormData {
  const fd = new FormData();
  fd.set("password", password);
  fd.set("confirmPassword", confirmPassword);
  return fd;
}

describe("resetPassword / resetPortalPassword — integration", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(() => {
    resetAuthMock();
    resetNavigationMock();
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("no session: returns the generic invalid/expired error, not a crash", async () => {
    const result = await resetPassword({ error: null }, resetForm("a-strong-password-1"));
    expect(result.error).toBe("This link is invalid or has expired. Request a new one to continue.");
  });

  it("weak password: rejected before ever reaching Supabase", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await resetPassword({ error: null }, resetForm("short1"));
    expect(result.error).toBe("Password must be at least 8 characters.");
  });

  it("mismatched confirmation: rejected", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await resetPassword({ error: null }, resetForm("a-strong-password-1", "a-different-password-1"));
    expect(result.error).toBe("Passwords do not match.");
  });

  it("missing fields: rejected", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await resetPassword({ error: null }, new FormData());
    expect(result.error).toBe("Both fields are required.");
  });

  it("staff: a valid session and a valid password succeed", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await resetPassword({ error: null }, resetForm("a-strong-password-1"));
    expect(result).toEqual({ error: null, message: "Password updated." });
  });

  it("portal: a valid session and a valid password succeed via the portal action too", async () => {
    actAs({ id: fixtures.portalUser.id, email: fixtures.portalUser.email }, fixtures.orgA.id);
    const result = await resetPortalPassword({ error: null }, resetForm("a-strong-password-1"));
    expect(result).toEqual({ error: null, message: "Password updated." });
  });

  it("portal: weak password is rejected the same way as staff", async () => {
    actAs({ id: fixtures.portalUser.id, email: fixtures.portalUser.email }, fixtures.orgA.id);
    const result = await resetPortalPassword({ error: null }, resetForm("short1"));
    expect(result.error).toBe("Password must be at least 8 characters.");
  });

  describe("signOutAndGoToLogin / signOutAndGoToPortalLogin", () => {
    it("staff: redirects to /login", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      await expect(signOutAndGoToLogin()).rejects.toBeInstanceOf(RedirectSignal);
      expect(getNavigationCalls()).toEqual([{ type: "redirect", url: "/login" }]);
    });

    it("portal: redirects to /portal/login", async () => {
      actAs({ id: fixtures.portalUser.id, email: fixtures.portalUser.email }, fixtures.orgA.id);
      await expect(signOutAndGoToPortalLogin()).rejects.toBeInstanceOf(RedirectSignal);
      expect(getNavigationCalls()).toEqual([{ type: "redirect", url: "/portal/login" }]);
    });
  });
});
