import { test, expect, type Page } from "@playwright/test";
import { seedE2EFixtures, cleanupTestData, type TestFixtures } from "./fixtures";

/**
 * Sale-Ready Phase B, PR1 (Password Recovery). Real Supabase Auth isn't
 * reachable in this sandbox any more than it is for login/signup (see
 * test/e2e/attachments.spec.ts's own doc comment for the general
 * reasoning) — so this suite never exercises supabase.auth.signInWithPassword
 * itself (TEST_MODE's stub client intentionally doesn't implement it — see
 * src/lib/supabase/server.ts). What IS real and fully exercised end to
 * end: the actual forms, the actual /auth/confirm Route Handler, the
 * actual Server Actions, real Prisma-backed identity resolution, and the
 * real observable outcome of a successful reset — the user is signed out
 * and lands back on a real, working login page ready to accept
 * credentials, never auto-logged-in on the strength of the recovery link
 * alone.
 *
 * Every test that needs a real, working link submits the actual
 * forgot-password form itself, within that same test, rather than relying
 * on an earlier test having already done so — deliberately: this suite's
 * own tokens are TEST_MODE-deterministic (see recovery-token.ts's own
 * doc comment), so it's tempting to skip the form and just compute a
 * token_hash directly, but that token only exists in the app's in-memory
 * store once a real submission has actually generated it. Each test stays
 * self-contained and order-independent this way.
 */

let fixtures: TestFixtures;

test.beforeAll(async () => {
  fixtures = await seedE2EFixtures();
});

test.afterAll(async () => {
  await cleanupTestData(fixtures);
});

async function requestReset(page: Page, forgotPasswordPath: string, email: string): Promise<void> {
  await page.goto(forgotPasswordPath);
  await page.getByLabel("Email").fill(email);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(forgotPasswordPath) && r.request().method() === "POST"),
    page.getByRole("button", { name: "Send reset link" }).click(),
  ]);
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
}

// Mirrors src/lib/auth/recovery-token.ts's own TEST_MODE-only deterministic
// encoding exactly — this sandbox has no real mailbox to read a real reset
// link out of, so after requestReset() above has caused the app to
// generate+store a token for `email`, this computes that exact same
// token_hash, the same "replicate the algorithm, can't import server-only
// code" technique test/support/e2e-session.ts's own encodeTestModeIdentity
// copy already uses.
function testTokenHash(email: string): string {
  return Buffer.from(email, "utf8").toString("base64url");
}

/**
 * Visits the confirm link and lands on the real destination page with the
 * resulting TEST_MODE session cookie visible to it.
 *
 * The extra page.goto(page.url()) below is a deliberate, verified
 * workaround for a Playwright/Chromium-specific quirk, not a reflection
 * of real user-facing behavior: a cookie set via Set-Cookie on the
 * redirect response IS present in the browser's cookie jar immediately
 * (confirmed directly via page.context().cookies() and via a raw
 * page.request.get(..., { maxRedirects: 0 }) inspection of the actual
 * Set-Cookie header — both correct), but the specific page render Chromium
 * produces for the redirect *target*, within that same page.goto() call,
 * was empirically observed to not see it — while a genuinely separate,
 * subsequent navigation to the exact same URL always does. Real browsers
 * are required by RFC 6265 to apply Set-Cookie before following a
 * redirect's Location, so this is treated as a test-harness-only
 * accommodation, not an application bug — production's real session
 * (established by Supabase's own verifyOtp(), through the ordinary
 * @supabase/ssr cookie adapter every other authenticated flow in this app
 * already relies on) never goes through this TEST_MODE-only cookie path
 * at all.
 */
async function visitConfirmLink(page: Page, email: string, audience: "staff" | "portal"): Promise<void> {
  const tokenHash = testTokenHash(email);
  await page.goto(`/auth/confirm?token_hash=${encodeURIComponent(tokenHash)}&audience=${audience}`);
  // Re-navigating to page.url() (the exact current URL) was empirically a
  // no-op that didn't pick up the freshly-set cookie either — only a
  // navigation whose target string actually differs from the current one
  // reliably does (see this function's own doc comment above for the full
  // finding). The real destination is fully determined by the verified
  // identity anyway (see /auth/confirm's own doc comment), so both
  // possible landing pages are known upfront regardless of what the
  // server actually decided — landing on the wrong one here would just
  // fail this function's caller's own next assertion.
  const destination = page.url().endsWith("/portal/reset-password") ? "/portal/reset-password" : "/reset-password";
  await page.goto(`${destination}?_e2e_settle=1`);
}

test.describe("Password recovery — Staff", () => {
  test("the login page links to forgot-password, and a known email shows the generic success screen", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);

    await requestReset(page, "/forgot-password", fixtures.owner.email);
  });

  test("an unknown email shows the identical success screen — no enumeration", async ({ page }) => {
    await requestReset(page, "/forgot-password", "never-signed-up-e2e@example.com");
  });

  test("an invalid, never-issued link shows the friendly invalid-link message, not a crash", async ({ page }) => {
    await page.goto("/auth/confirm?token_hash=never-issued-e2e&audience=staff");
    await expect(page).toHaveURL(/\/reset-password/);
    await expect(page.getByRole("heading", { name: "This link is invalid or has expired" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Request a new link" })).toBeVisible();
  });

  test("a real link: weak password and mismatched confirmation are both rejected inline before a successful reset", async ({
    page,
  }) => {
    await requestReset(page, "/forgot-password", fixtures.owner.email);
    await visitConfirmLink(page, fixtures.owner.email, "staff");
    await expect(page).toHaveURL(/\/reset-password(\?|$)/);
    await expect(page.getByRole("heading", { name: "Set a new password" })).toBeVisible();

    await page.getByLabel(/^New password/).fill("short1");
    await page.getByLabel("Confirm new password").fill("short1");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByText("Password must be at least 8 characters.")).toBeVisible();

    await page.getByLabel(/^New password/).fill("a-strong-password-1");
    await page.getByLabel("Confirm new password").fill("a-different-password-1");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByText("Passwords do not match.")).toBeVisible();

    await page.getByLabel(/^New password/).fill("a-strong-password-1");
    await page.getByLabel("Confirm new password").fill("a-strong-password-1");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByRole("heading", { name: "Password updated" })).toBeVisible();

    // Signed out, not auto-logged-in — lands on the real, working login page.
    await page.getByRole("button", { name: "Continue to sign in" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("a reset link is single-use: revisiting it after a successful reset shows the invalid-link message", async ({
    page,
  }) => {
    await requestReset(page, "/forgot-password", fixtures.member.email);
    await visitConfirmLink(page, fixtures.member.email, "staff");
    await page.getByLabel(/^New password/).fill("a-strong-password-1");
    await page.getByLabel("Confirm new password").fill("a-strong-password-1");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByRole("heading", { name: "Password updated" })).toBeVisible();
    // Ends the recovery session — see resetPasswordCore's own doc comment
    // for why that's deliberately deferred to this click, not the reset
    // itself. Without this, the still-active session (not the by-then-
    // already-consumed token) would be why a second visit still worked.
    await page.getByRole("button", { name: "Continue to sign in" }).click();
    await expect(page).toHaveURL(/\/login$/);

    await visitConfirmLink(page, fixtures.member.email, "staff");
    await expect(page.getByRole("heading", { name: "This link is invalid or has expired" })).toBeVisible();
  });
});

test.describe("Password recovery — Portal", () => {
  test("the portal login page links to forgot-password, and a known portal email shows the success screen", async ({
    page,
  }) => {
    await page.goto("/portal/login");
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page).toHaveURL(/\/portal\/forgot-password$/);

    await requestReset(page, "/portal/forgot-password", fixtures.portalUser.email);
  });

  test("a real portal link lands on the portal reset-password page (not the staff one), even with a wrong audience hint", async ({
    page,
  }) => {
    await requestReset(page, "/portal/forgot-password", fixtures.portalUser.email);
    // audience hint deliberately "staff" — the confirm route re-derives
    // the real destination from the verified identity, never trusting
    // this pre-verification hint. See that route's own doc comment.
    await visitConfirmLink(page, fixtures.portalUser.email, "staff");
    await expect(page).toHaveURL(/\/portal\/reset-password(\?|$)/);
    await expect(page.getByRole("heading", { name: "Set a new password" })).toBeVisible();

    await page.getByLabel(/^New password/).fill("a-strong-password-1");
    await page.getByLabel("Confirm new password").fill("a-strong-password-1");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByRole("heading", { name: "Password updated" })).toBeVisible();

    await page.getByRole("button", { name: "Continue to sign in" }).click();
    await expect(page).toHaveURL(/\/portal\/login$/);
  });

  test("an invalid portal link shows the friendly invalid-link message on the portal page", async ({ page }) => {
    await page.goto("/auth/confirm?token_hash=never-issued-e2e&audience=portal");
    await expect(page).toHaveURL(/\/portal\/reset-password/);
    await expect(page.getByRole("heading", { name: "This link is invalid or has expired" })).toBeVisible();
  });
});
