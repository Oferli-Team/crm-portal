import { test, expect } from "@playwright/test";
import { seedE2EFixtures, cleanupTestData, type TestFixtures } from "./fixtures";
import { injectTestSession } from "../support/e2e-session";

/**
 * Sale-Ready Phase C, PR1 (Foundation). Exercises the real
 * requirePlatformAdmin() guard end to end — no page has any real data
 * yet (that ships in PR2-PR4), so this suite only proves the boundary:
 * who gets in, who gets redirected, and where to. PLATFORM_ADMIN_EMAILS
 * is fixed in playwright.config.ts's webServer env to exactly the one
 * address this suite injects a session for.
 */

const PLATFORM_ADMIN_EMAIL = "platform-admin-e2e@example.com";

let fixtures: TestFixtures;

test.beforeAll(async () => {
  fixtures = await seedE2EFixtures();
});

test.afterAll(async () => {
  await cleanupTestData(fixtures);
});

test("no session redirects to /login", async ({ page }) => {
  await page.goto("/platform-admin");
  await expect(page).toHaveURL(/\/login$/);
});

test("an authenticated but non-allowlisted staff user is redirected to /dashboard, never shown an access-denied page", async ({
  context,
  baseURL,
}) => {
  await injectTestSession(context, { id: fixtures.owner.id, email: fixtures.owner.email }, baseURL!);
  const page = await context.newPage();

  await page.goto("/platform-admin");
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText("Access denied")).toHaveCount(0);
});

test("the allowlisted identity reaches the Platform Admin shell, with nav to all four sections", async ({ context, baseURL }) => {
  await injectTestSession(context, { id: "e2e-platform-admin-user", email: PLATFORM_ADMIN_EMAIL }, baseURL!);
  const page = await context.newPage();

  await page.goto("/platform-admin");
  await expect(page).toHaveURL(/\/platform-admin$/);
  await expect(page.getByRole("heading", { name: "Platform Dashboard", level: 1 })).toBeVisible();
  await expect(page.getByText(PLATFORM_ADMIN_EMAIL)).toBeVisible();

  await page.getByRole("navigation", { name: "Platform Admin" }).getByRole("link", { name: "Organizations" }).click();
  await expect(page).toHaveURL(/\/platform-admin\/organizations$/);
  await expect(page.getByRole("heading", { name: "Organizations", level: 1 })).toBeVisible();

  await page.getByRole("navigation", { name: "Platform Admin" }).getByRole("link", { name: "Users" }).click();
  await expect(page).toHaveURL(/\/platform-admin\/users$/);
  await expect(page.getByRole("heading", { name: "Users", level: 1 })).toBeVisible();

  await page.getByRole("navigation", { name: "Platform Admin" }).getByRole("link", { name: "Configuration" }).click();
  await expect(page).toHaveURL(/\/platform-admin\/configuration$/);
  await expect(page.getByRole("heading", { name: "Configuration", level: 1 })).toBeVisible();
});

test("a Client Portal identity is redirected away, same as any other non-allowlisted identity", async ({ context, baseURL }) => {
  await injectTestSession(context, { id: fixtures.portalUser.id, email: fixtures.portalUser.email }, baseURL!);
  const page = await context.newPage();

  await page.goto("/platform-admin");
  // Portal identities have no Membership, so requirePlatformAdmin's own
  // failure path (redirect to /dashboard) runs — /dashboard's own guard
  // then further redirects a portal-only identity on to /portal, exactly
  // as it already does for any other staff-only route.
  await expect(page).toHaveURL(/\/portal$/);
});
