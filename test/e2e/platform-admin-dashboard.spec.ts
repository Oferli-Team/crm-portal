import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { seedE2EFixtures, cleanupTestData, dbQuery, type TestFixtures } from "./fixtures";
import { injectTestSession } from "../support/e2e-session";

/**
 * Sale-Ready Phase C, PR2 (Platform Dashboard). PLATFORM_ADMIN_EMAILS is
 * fixed in playwright.config.ts's webServer env to exactly this address
 * (see test/e2e/platform-admin.spec.ts, which owns the guard/nav coverage
 * — this file only covers the real KPI data this PR adds).
 *
 * Reads a metric, causes a real, independent change, re-reads it, and
 * asserts the exact delta — the same technique staff-app.spec.ts already
 * uses for the tenant dashboard's own "Total clients" card — rather than
 * asserting an absolute count, which would be brittle against whatever
 * else exists in the shared E2E database.
 */

const PLATFORM_ADMIN_EMAIL = "platform-admin-e2e@example.com";

let fixtures: TestFixtures;

test.beforeAll(async () => {
  fixtures = await seedE2EFixtures();
});

test.afterAll(async () => {
  await cleanupTestData(fixtures);
});

/**
 * Scoped to <main> deliberately — the (platform-admin) layout's own top
 * nav (see src/app/(platform-admin)/layout.tsx) has an "Organizations"
 * link with the identical accessible name as the "Organizations"
 * MetricCard's own link, and getByRole's `name` match is substring-based
 * by default, so an unscoped query would resolve to more than one link
 * and fail Playwright's strict-mode check.
 */
function readMetric(page: import("@playwright/test").Page, label: string | RegExp) {
  return page
    .locator("main")
    .getByRole("link", { name: label })
    .locator("p")
    .nth(1)
    .innerText()
    .then((text) => Number(text.trim()));
}

test("registering a brand-new organization moves Organizations, Active trials, and Staff users by exactly one, and it appears in Newest organizations", async ({
  context,
  baseURL,
}) => {
  await injectTestSession(context, { id: "e2e-platform-admin-dashboard", email: PLATFORM_ADMIN_EMAIL }, baseURL!);
  const page = await context.newPage();
  await page.goto("/platform-admin");

  const orgsBefore = await readMetric(page, "Organizations");
  const activeTrialsBefore = await readMetric(page, "Active trials");
  const staffUsersBefore = await readMetric(page, "Staff users");

  // A fresh identity with no existing Membership auto-provisions a brand
  // new personal Organization + Membership + real TRIALING Subscription
  // the moment it hits a staff-only page — the same mechanism
  // current-user.ts's own getOrCreateOrganizationId doc comment describes,
  // and the same technique this suite's own platform-admin.spec.ts already
  // uses to exercise the "non-allowlisted staff user" redirect.
  const runId = Date.now();
  const newStaffId = randomUUID();
  const newStaffEmail = `e2e-new-org-${runId}@example.com`;
  const newOrgName = `E2E New Org ${runId}`;

  await injectTestSession(context, { id: newStaffId, email: newStaffEmail }, baseURL!);
  const setupPage = await context.newPage();
  await setupPage.goto("/dashboard");
  await expect(setupPage).toHaveURL(/\/dashboard$/);
  await setupPage.close();

  // Real name isn't controllable via injectTestSession's identity payload
  // alone (getOrCreateOrganizationId falls back to "${user.name}'s
  // Workspace", and the test-mode identity has no name field at all) — so
  // this test doesn't assume the exact org name, only that the created
  // row is discoverable via its owning user, then renames it via a direct
  // DB write so the "Newest organizations" assertion below has a known,
  // collision-free name to look for.
  const membership = await dbQuery<{ organizationId: string }>("membership", "findFirstOrThrow", {
    where: { userId: newStaffId, role: "OWNER" },
  });
  await dbQuery("organization", "update", { where: { id: membership.organizationId }, data: { name: newOrgName } });

  try {
    await injectTestSession(context, { id: "e2e-platform-admin-dashboard", email: PLATFORM_ADMIN_EMAIL }, baseURL!);
    await page.goto("/platform-admin");

    const orgsAfter = await readMetric(page, "Organizations");
    const activeTrialsAfter = await readMetric(page, "Active trials");
    const staffUsersAfter = await readMetric(page, "Staff users");

    expect(orgsAfter).toBe(orgsBefore + 1);
    expect(activeTrialsAfter).toBe(activeTrialsBefore + 1);
    expect(staffUsersAfter).toBe(staffUsersBefore + 1);

    await expect(page.getByText(newOrgName)).toBeVisible();
  } finally {
    // FK-aware order — same reasoning prior production verification
    // scripts already document: delete the Organization first (cascades
    // Membership/Subscription), then the User row.
    await dbQuery("organization", "delete", { where: { id: membership.organizationId } });
    await dbQuery("user", "delete", { where: { id: newStaffId } });
  }
});

test("the KPI grid and Newest organizations both render real, non-negative numbers on first load", async ({ context, baseURL }) => {
  await injectTestSession(context, { id: "e2e-platform-admin-dashboard-2", email: PLATFORM_ADMIN_EMAIL }, baseURL!);
  const page = await context.newPage();
  await page.goto("/platform-admin");

  for (const label of [
    "Organizations",
    "Active trials",
    "Active subscriptions",
    "Expired trials",
    "Staff users",
    "Portal users",
    "Clients",
    "Projects",
    "Tasks",
    "Today",
    "Last 7 days",
  ]) {
    const value = await readMetric(page, label);
    expect(Number.isFinite(value), `${label} should render a real number, got ${value}`).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
});
