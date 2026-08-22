/**
 * E2E-only identity bypass — exists because this sandbox has no real
 * Supabase Auth available locally (no Docker, no writable Homebrew; see
 * the Stage 4 report). Playwright's E2E suite runs the real, compiled app
 * (via `next start`) against the real Prisma business logic, but injects
 * an identity directly instead of a real Supabase session, since there is
 * no local Auth service to sign in against.
 *
 * Gated on a single, exact check: `process.env.TEST_MODE === "1"`. This
 * env var:
 *   - is never set in `.env`/`.env.example`, `vercel.json`, or any other
 *     committed config (see scripts/security-checks/check-no-test-mode.mjs,
 *     which fails CI if it ever is);
 *   - is set ONLY by playwright.config.ts's `webServer.env`, which only
 *     applies to the `next start` process Playwright itself spawns for
 *     the E2E run — never to `npm run build`/`npm start` run normally,
 *     never to the Vercel deployment, never to ci-fast.yml's own build
 *     step (which builds and type-checks with no TEST_MODE set at all,
 *     proving this code path is unreachable in that build).
 *
 * Every consumer (src/lib/supabase/server.ts, src/lib/supabase/
 * middleware.ts) checks `TEST_MODE` before doing anything else — in a
 * real deployment (TEST_MODE always false) both fall through to the
 * exact same real Supabase Auth code that ran before this file existed.
 */
export const TEST_MODE = process.env.TEST_MODE === "1";

export const TEST_USER_COOKIE = "x_e2e_test_user";

export type TestModeIdentity = { id: string; email: string };

/** Used by both the app (reading the cookie) and Playwright's own session-injection helper (writing it) — one shared encoding, not two. */
export function encodeTestModeIdentity(identity: TestModeIdentity): string {
  return Buffer.from(JSON.stringify(identity), "utf8").toString("base64url");
}

export function decodeTestModeIdentity(cookieValue: string | undefined | null): TestModeIdentity | null {
  if (!TEST_MODE || !cookieValue) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cookieValue, "base64url").toString("utf8"));
    if (typeof parsed?.id === "string" && typeof parsed?.email === "string") {
      return { id: parsed.id, email: parsed.email };
    }
  } catch {
    // Malformed cookie — treated as "no identity", never thrown.
  }
  return null;
}
