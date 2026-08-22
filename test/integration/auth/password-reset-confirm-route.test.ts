import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// See password-reset-request.test.ts's own doc comment for why.
vi.mock("server-only", () => ({}));

// src/lib/test-mode.ts's TEST_MODE is a module-level const, computed once
// from process.env.TEST_MODE at first evaluation — must be set before
// anything in the /auth/confirm route's own module graph (recovery-token.ts,
// test-mode.ts) is ever imported, so this route can exercise the real
// TEST_MODE branch (an in-memory token store + the identity-cookie
// bypass), the same "no real Supabase Auth reachable" reasoning
// src/lib/storage/test-storage.ts already follows. Dynamic imports below
// guarantee that ordering (same technique test/integration/cron/routes.test.ts
// already uses for its own env-dependent module).
const ORIGINAL_TEST_MODE = process.env.TEST_MODE;
process.env.TEST_MODE = "1";

const { GET: confirmGet } = await import("@/app/auth/confirm/route");
const { generateRecoveryToken } = await import("@/lib/auth/recovery-token");
const { decodeTestModeIdentity } = await import("@/lib/test-mode");

import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";

// The confirm route sets its TEST_MODE identity cookie directly on the
// NextResponse it returns (response.cookies.set(...)), not via
// next/headers' cookies() — see testModeRecoveryCookie's own doc comment
// for why that distinction matters. NextResponse.cookies is a real,
// self-contained ResponseCookies jar, readable straight off the returned
// Response — no mock needed for this at all.
const TEST_USER_COOKIE_NAME = "x_e2e_test_user";

function confirmRequest(params: Record<string, string>): Request {
  const url = new URL("http://localhost/auth/confirm");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url);
}

afterAll(() => {
  if (ORIGINAL_TEST_MODE === undefined) {
    delete process.env.TEST_MODE;
  } else {
    process.env.TEST_MODE = ORIGINAL_TEST_MODE;
  }
});

describe("/auth/confirm — integration (real Route Handler, TEST_MODE token branch)", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("no token_hash at all: redirects to the staff reset-password page with invalid=1", async () => {
    const response = await confirmGet(confirmRequest({}));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/reset-password?invalid=1");
  });

  it("an unknown/malformed token: redirects with invalid=1, no session established", async () => {
    const response = await confirmGet(confirmRequest({ token_hash: "never-issued", audience: "staff" }));
    expect(response.headers.get("location")).toBe("http://localhost/reset-password?invalid=1");
    expect(response.cookies.get(TEST_USER_COOKIE_NAME)).toBeUndefined();
  });

  it("a valid staff token: redirects to /reset-password and establishes the identity-cookie session", async () => {
    const generated = await generateRecoveryToken(fixtures.owner.email);
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;

    const response = await confirmGet(confirmRequest({ token_hash: generated.tokenHash, audience: "staff" }));
    expect(response.headers.get("location")).toBe("http://localhost/reset-password");

    const cookie = response.cookies.get(TEST_USER_COOKIE_NAME);
    expect(cookie).toBeDefined();
    expect(decodeTestModeIdentity(cookie?.value)).toEqual({ id: fixtures.owner.id, email: fixtures.owner.email });
  });

  it("a valid portal token: redirects to /portal/reset-password, regardless of the audience hint", async () => {
    const generated = await generateRecoveryToken(fixtures.portalUser.email);
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;

    // audience hint deliberately wrong ("staff") — the route must
    // re-derive the real destination from the verified identity, not
    // trust this pre-verification default. See the route's own doc
    // comment for why that's the whole point of resolving it this way.
    const response = await confirmGet(confirmRequest({ token_hash: generated.tokenHash, audience: "staff" }));
    expect(response.headers.get("location")).toBe("http://localhost/portal/reset-password");

    const cookie = response.cookies.get(TEST_USER_COOKIE_NAME);
    expect(decodeTestModeIdentity(cookie?.value)).toEqual({
      id: fixtures.portalUser.id,
      email: fixtures.portalUser.email,
    });
  });

  it("a token is single-use: verifying it a second time fails", async () => {
    const generated = await generateRecoveryToken(fixtures.owner.email);
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;

    const first = await confirmGet(confirmRequest({ token_hash: generated.tokenHash, audience: "staff" }));
    expect(first.headers.get("location")).toBe("http://localhost/reset-password");

    const second = await confirmGet(confirmRequest({ token_hash: generated.tokenHash, audience: "staff" }));
    expect(second.headers.get("location")).toBe("http://localhost/reset-password?invalid=1");
    expect(second.cookies.get(TEST_USER_COOKIE_NAME)).toBeUndefined();
  });

  it("an unknown audience value falls back to the staff destination for the invalid-link case", async () => {
    const response = await confirmGet(confirmRequest({ token_hash: "never-issued", audience: "not-a-real-value" }));
    expect(response.headers.get("location")).toBe("http://localhost/reset-password?invalid=1");
  });
});
