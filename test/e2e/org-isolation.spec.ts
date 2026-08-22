import { test, expect } from "@playwright/test";
import { seedE2EFixtures, cleanupTestData, type TestFixtures } from "./fixtures";
import { injectTestSession } from "../support/e2e-session";

// B. Organization isolation — fixtures.owner is a genuine OWNER of Org A
// (see src/lib/current-user.ts's resolveActiveOrganizationId: an unrecognized
// active_organization_id cookie falls back to getOrCreateOrganizationId,
// which looks for an existing OWNER membership before ever auto-provisioning
// a new org — using `owner` here, rather than `member`/`admin`, is what
// makes the fallback outcome deterministic instead of creating a throwaway
// personal org).

let fixtures: TestFixtures;

test.beforeAll(async () => {
  fixtures = await seedE2EFixtures();
});

test.afterAll(async () => {
  await cleanupTestData(fixtures);
});

test("a forged active_organization_id cookie pointing at a foreign org never leaks its data, and falls back to an allowed org", async ({ context, baseURL }) => {
  await injectTestSession(context, { id: fixtures.owner.id, email: fixtures.owner.email }, baseURL!);

  // Forge the cookie to Org B, where `owner` holds no Membership at all.
  const url = new URL(baseURL!);
  await context.addCookies([
    {
      name: "active_organization_id",
      value: fixtures.orgB.id,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);

  const page = await context.newPage();

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard/);
  // Single-membership org switcher renders as a plain span (see
  // organization-switcher.tsx) — the fallback landed on Org A, never Org B.
  await expect(page.getByText("Test Org A", { exact: true })).toBeVisible();
  await expect(page.getByText(fixtures.orgB.slug)).toHaveCount(0);

  await page.goto("/clients");
  await expect(page.getByRole("row", { name: fixtures.clientA.name })).toBeVisible();
  await expect(page.getByText(fixtures.clientB.name, { exact: true })).toHaveCount(0);
});
