import { test, expect } from "@playwright/test";
import { seedE2EFixtures, cleanupTestData, type TestFixtures } from "./fixtures";
import { injectTestSession } from "../support/e2e-session";

// Regression coverage for the app-wide tablet-breakpoint horizontal
// overflow (issue #20). Root cause: the (dashboard) layout's flex-1
// column (Header + main, sibling of the now-fixed-width Sidebar at the
// md breakpoint) had no min-w-0, so it never shrank below its content's
// intrinsic width — the exact same default `min-width: auto` flex trap
// header.tsx's own mobile-overflow fix (PR #19) already fixed for the
// header's own internal row. Covers every width named in the ticket,
// both the wide-tablet breakpoints that regressed and the narrow mobile
// breakpoints PR #19 already fixed, so a future change can't reintroduce
// either.
const WIDTHS = [320, 375, 390, 430, 768, 800, 834, 1024];

async function assertNoHorizontalOverflow(page: import("@playwright/test").Page, path: string) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(path);
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth, `${path} at ${width}px: scrollWidth (${scrollWidth}) should not exceed clientWidth (${clientWidth})`).toBeLessThanOrEqual(clientWidth);
  }
}

let fixtures: TestFixtures;

test.beforeAll(async () => {
  fixtures = await seedE2EFixtures();
});

test.afterAll(async () => {
  await cleanupTestData(fixtures);
});

test.describe("staff dashboard routes", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await injectTestSession(context, { id: fixtures.owner.id, email: fixtures.owner.email }, baseURL!);
  });

  for (const path of ["/dashboard", "/clients", "/projects", "/tasks", "/settings/notifications", "/settings/billing", "/analytics"]) {
    test(`no horizontal overflow on ${path}`, async ({ page }) => {
      await assertNoHorizontalOverflow(page, path);
    });
  }

  test("desktop layout unchanged at 1280px", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/dashboard");
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  });

  test("organization switcher remains usable at the tablet breakpoint", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto("/dashboard");
    // fixtures.owner belongs to a single organization, so the switcher
    // renders as the plain (non-dropdown) name/slug block — see
    // organization-switcher.tsx's own `organizations.length === 1` branch.
    await expect(page.getByText(/Test Org A/)).toBeVisible();
  });

  test("sign out remains reachable at the tablet breakpoint", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto("/dashboard");
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  });
});

test.describe("client portal route", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await injectTestSession(context, { id: fixtures.portalUser.id, email: fixtures.portalUser.email }, baseURL!);
  });

  test("no horizontal overflow on /portal", async ({ page }) => {
    await assertNoHorizontalOverflow(page, "/portal");
  });
});
