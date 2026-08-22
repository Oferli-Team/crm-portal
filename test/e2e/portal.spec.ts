import { test, expect } from "@playwright/test";
import { seedE2EFixtures, cleanupTestData, dbQuery, type TestFixtures } from "./fixtures";
import { injectTestSession } from "../support/e2e-session";

// C. Client Portal — a portal-only identity (fixtures.portalUser, whose id
// is the Supabase auth user id per src/lib/current-portal-user.ts's
// resolvePortalIdentity: PortalUser.id === authUser.id) has no Membership
// row at all, so it must never reach the staff app.

let fixtures: TestFixtures;

test.beforeAll(async () => {
  fixtures = await seedE2EFixtures();
});

test.afterAll(async () => {
  await cleanupTestData(fixtures);
});

test.beforeEach(async ({ context, baseURL }) => {
  await injectTestSession(context, { id: fixtures.portalUser.id, email: fixtures.portalUser.email }, baseURL!);
});

test("portal opens for a portal-only identity, with no staff navigation present", async ({ page }) => {
  await page.goto("/portal");
  await expect(page).toHaveURL(/\/portal$/);
  await expect(page.getByRole("heading", { name: fixtures.clientA.name })).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Client Portal" });
  await expect(nav.getByRole("link", { name: "Projects" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Invoices" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Profile" })).toBeVisible();

  // The staff Sidebar's own "Primary" nav (Clients/Tasks/Team/...) must
  // never be reachable from a portal-only identity.
  await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Team" })).toHaveCount(0);
});

test("visiting /dashboard as a portal-only identity redirects to /portal", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/portal$/);
});

test("Projects, Invoices, and Profile render for the portal identity", async ({ page }) => {
  await page.goto("/portal/projects");
  await expect(page).toHaveURL(/\/portal\/projects/);
  await expect(page.getByRole("link", { name: fixtures.project.name })).toBeVisible();

  // fixtures.invoice is DRAFT and, since Invoice System Official Slice 5
  // (docs/invoicing-architecture.md §10), is correctly never Portal-visible
  // — a dedicated SENT invoice proves the Invoices tab itself renders real
  // content, without relying on the fixed DRAFT-visibility bug.
  const visibleInvoice = await dbQuery<{ id: string; invoiceNumber: string }>("invoice", "create", {
    data: {
      invoiceNumber: `E2E-PORTAL-VISIBLE-${fixtures.runId}`,
      status: "SENT",
      amount: "10.00",
      projectId: fixtures.project.id,
      clientId: fixtures.clientA.id,
      organizationId: fixtures.orgA.id,
    },
  });

  await page.goto("/portal/invoices");
  await expect(page).toHaveURL(/\/portal\/invoices/);
  await expect(page.getByRole("row", { name: new RegExp(visibleInvoice.invoiceNumber) })).toBeVisible();

  await page.goto("/portal/profile");
  await expect(page).toHaveURL(/\/portal\/profile/);
  await expect(page.getByRole("main").getByText(fixtures.portalUser.email)).toBeVisible();

  await dbQuery("invoice", "deleteMany", { where: { id: visibleInvoice.id } });
});

test("sign out clears the portal session, and /portal then redirects to /portal/login", async ({ page }) => {
  await page.goto("/portal");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/portal\/login/);

  await page.goto("/portal");
  await expect(page).toHaveURL(/\/portal\/login/);
});

test("visiting the portal with no session redirects to /portal/login", async ({ context, baseURL }) => {
  const freshContext = await context.browser()!.newContext();
  const freshPage = await freshContext.newPage();
  await freshPage.goto(`${baseURL}/portal`);
  await expect(freshPage).toHaveURL(/\/portal\/login/);
  await freshContext.close();
});
