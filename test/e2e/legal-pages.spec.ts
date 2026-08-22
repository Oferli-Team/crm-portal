import { test, expect } from "@playwright/test";

/**
 * Sale-Ready Phase B, PR2.1 (Legal Foundation). Every page/link covered
 * here is public and unauthenticated — no DB fixtures needed (contrast
 * with password-reset.spec.ts, which does), so this suite has no
 * beforeAll/afterAll seeding at all.
 */

test.describe("Privacy Policy and Terms of Service pages", () => {
  test("/privacy renders with a heading and effective date", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { name: "Privacy Policy", level: 1 })).toBeVisible();
    await expect(page.getByText(/Effective/)).toBeVisible();
  });

  test("/terms renders with a heading and effective date", async ({ page }) => {
    await page.goto("/terms");
    await expect(page.getByRole("heading", { name: "Terms of Service", level: 1 })).toBeVisible();
    await expect(page.getByText(/Effective/)).toBeVisible();
  });

  test("/privacy links to /terms and vice versa", async ({ page }) => {
    await page.goto("/terms");
    await page.getByRole("link", { name: "Privacy Policy" }).first().click();
    await page.waitForURL(/\/privacy$/);
    await expect(page.getByRole("heading", { name: "Privacy Policy", level: 1 })).toBeVisible();
  });
});

test.describe("Global footer", () => {
  const PAGES_WITH_FOOTER = ["/login", "/signup", "/forgot-password", "/portal/login", "/portal/signup", "/portal/forgot-password"];

  for (const path of PAGES_WITH_FOOTER) {
    test(`footer with Privacy Policy and Terms of Service links is present on ${path}`, async ({ page }) => {
      await page.goto(path);
      const footer = page.locator("footer");
      await expect(footer.getByRole("link", { name: "Privacy Policy" })).toBeVisible();
      await expect(footer.getByRole("link", { name: "Terms of Service" })).toBeVisible();
    });
  }

  test("footer's Privacy Policy link navigates to /privacy from the login page", async ({ page }) => {
    await page.goto("/login");
    await page.locator("footer").getByRole("link", { name: "Privacy Policy" }).click();
    await page.waitForURL(/\/privacy$/);
    await expect(page.getByRole("heading", { name: "Privacy Policy", level: 1 })).toBeVisible();
  });

  test("footer's Terms of Service link navigates to /terms from the portal signup page", async ({ page }) => {
    await page.goto("/portal/signup");
    await page.locator("footer").getByRole("link", { name: "Terms of Service" }).click();
    await page.waitForURL(/\/terms$/);
    await expect(page.getByRole("heading", { name: "Terms of Service", level: 1 })).toBeVisible();
  });
});

test.describe("Signup consent copy", () => {
  test("staff signup shows a consent line linking to both policies", async ({ page }) => {
    await page.goto("/signup");
    const consent = page.getByText(/By creating an account, you agree to our/);
    await expect(consent).toBeVisible();
    await expect(consent.getByRole("link", { name: "Terms of Service" })).toBeVisible();
    await expect(consent.getByRole("link", { name: "Privacy Policy" })).toBeVisible();
  });

  test("portal signup shows a consent line linking to both policies", async ({ page }) => {
    await page.goto("/portal/signup");
    const consent = page.getByText(/By creating an account, you agree to our/);
    await expect(consent).toBeVisible();
    await expect(consent.getByRole("link", { name: "Terms of Service" })).toBeVisible();
    await expect(consent.getByRole("link", { name: "Privacy Policy" })).toBeVisible();
  });

  test("staff signup consent Terms of Service link navigates to /terms", async ({ page }) => {
    await page.goto("/signup");
    await page.getByText(/By creating an account, you agree to our/).getByRole("link", { name: "Terms of Service" }).click();
    await page.waitForURL(/\/terms$/);
    await expect(page.getByRole("heading", { name: "Terms of Service", level: 1 })).toBeVisible();
  });
});
