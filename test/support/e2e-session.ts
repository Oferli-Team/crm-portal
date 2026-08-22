import type { BrowserContext } from "@playwright/test";

// Mirrors src/lib/test-mode.ts exactly (can't import it directly — that
// file is server-only Next.js code, not meant to run inside Playwright's
// own Node process). Keeping the cookie name/encoding in sync is enforced
// by scripts/security-checks/check-no-test-mode.mjs's "shared gate"
// check on the app side, and by test/integration having already exercised
// decodeTestModeIdentity()'s exact inverse of this encoding.
const TEST_USER_COOKIE = "x_e2e_test_user";

export type E2EIdentity = { id: string; email: string };

function encode(identity: E2EIdentity): string {
  return Buffer.from(JSON.stringify(identity), "utf8").toString("base64url");
}

/**
 * Injects a test identity directly into the browser context — the E2E
 * equivalent of Stage 4's auth-mock harness, necessary because this
 * sandbox has no real Supabase Auth to sign in against (see the Stage 5
 * report). Every other authorization boundary (Prisma queries scoped by
 * organizationId/clientId, role checks, ...) still runs for real; only
 * identity resolution is short-circuited, and only when the app itself
 * was started with TEST_MODE=1 (see playwright.config.ts's webServer).
 */
export async function injectTestSession(context: BrowserContext, identity: E2EIdentity, baseURL: string): Promise<void> {
  const url = new URL(baseURL);
  await context.addCookies([
    {
      name: TEST_USER_COOKIE,
      value: encode(identity),
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      secure: url.protocol === "https:",
      sameSite: "Lax",
    },
  ]);
}
