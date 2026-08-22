import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { portalLogin } from "@/app/portal/login/actions";
import { recordPortalLogin } from "@/lib/client-portal/analytics-events";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { setMockSignInConfig, resetAuthMock } from "../../support/auth-mock";
import { RedirectSignal, resetNavigationMock } from "../../support/navigation-mock";

/**
 * Portal Analytics persistence foundation (docs/analytics-architecture.md
 * §12, Slice 1) — isolated in its own file (rather than a case inside
 * login.test.ts) specifically so this one file's module-level mock of the
 * write-helper never affects login.test.ts's own real-write assertions.
 * recordPortalLogin() already proves its own internal try/catch never
 * throws (test/integration/portal/analytics-events.test.ts); this proves
 * the two things that test can't: that a helper failure genuinely never
 * blocks the real, user-facing login success path, and that portalLogin
 * actually calls the helper — with the real Prisma client and the real
 * PortalUser id — rather than the redirect succeeding for some unrelated
 * reason.
 */
vi.mock("@/lib/client-portal/analytics-events", () => ({
  recordPortalLogin: vi.fn(async () => false),
}));

const mockedRecordPortalLogin = vi.mocked(recordPortalLogin);

describe("portalLogin — a recordPortalLogin failure never blocks a successful login", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(() => {
    resetAuthMock();
    resetNavigationMock();
    mockedRecordPortalLogin.mockClear();
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("still redirects successfully, and calls recordPortalLogin exactly once with the real prisma client and the real PortalUser id, even when the helper reports failure", async () => {
    setMockSignInConfig({
      kind: "success",
      user: { id: fixtures.portalUser.id, email: fixtures.portalUser.email },
    });

    const formData = new FormData();
    formData.set("email", fixtures.portalUser.email);
    formData.set("password", "correct-horse-battery-staple");

    await expect(portalLogin({ error: null }, formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockedRecordPortalLogin).toHaveBeenCalledTimes(1);
    // Reference-identity checks, not toHaveBeenCalledWith(prisma, ...) —
    // a deep-equality match against the real Prisma client (a large,
    // lazily-getter-backed object) overflows the call stack. `toBe` is
    // also the more precise assertion here: it proves this is literally
    // the same singleton portalLogin imports, not merely an
    // equal-looking object.
    const [calledClient, calledPortalUserId] = mockedRecordPortalLogin.mock.calls[0];
    expect(calledClient).toBe(prisma);
    expect(calledPortalUserId).toBe(fixtures.portalUser.id);
  });
});
