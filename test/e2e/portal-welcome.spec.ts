import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { seedE2EFixtures, cleanupTestData, dbQuery, type TestFixtures } from "./fixtures";
import { injectTestSession } from "../support/e2e-session";
import { testEmail, testSlug } from "../support/run-id";
import { TEST_EMAIL_DOMAIN } from "../support/env";

/**
 * Client Portal welcome banner — Stage 4 (docs/onboarding-architecture.md
 * §17). Real-browser coverage for src/components/portal/portal-welcome-
 * banner.tsx: what actually renders for an eligible vs. an old PortalUser,
 * that the existing Projects/Invoices empty states are untouched, that the
 * staff app never sees this, and that no other Portal page does either.
 * The eligibility function itself is already exhaustively unit-tested
 * (test/unit/portal-welcome-eligibility.test.ts) and integration-tested
 * against real Postgres (test/integration/portal/welcome-eligibility.test.ts)
 * — this file only covers what needs a real browser.
 */

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

async function actAsPortal(
  context: BrowserContext,
  baseURL: string,
  identity: { id: string; email: string },
): Promise<void> {
  await context.clearCookies();
  await injectTestSession(context, identity, baseURL);
}

async function gotoAndSettle(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

function welcomeBanner(page: Page) {
  return page.getByRole("region", { name: "Welcome to your client portal" });
}

/**
 * Stage 6 audit fix regression guard. `:focus-visible` matching for a
 * *programmatic* `.focus()` call is a browser/automation heuristic that
 * isn't guaranteed consistent — this checks the actual rendered effect
 * instead (a real box-shadow or outline), deterministic regardless of
 * which pseudo-class ends up matching.
 */
async function hasVisibleFocusIndicator(locator: ReturnType<Page["locator"]>): Promise<boolean> {
  return locator.evaluate((el) => {
    const style = getComputedStyle(el);
    const hasShadow = style.boxShadow !== "none" && style.boxShadow !== "";
    const hasOutline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth || "0") > 0;
    return hasShadow || hasOutline;
  });
}

type FreshPortalIdentity = { client: { id: string }; portalUser: { id: string; email: string } };

/** A brand-new Client with zero Projects/Invoices and a fresh (eligible) PortalUser — for proving the welcome banner never displaces the existing empty states. */
async function createFreshPortalIdentity(runId: string, label: string): Promise<FreshPortalIdentity> {
  const org = await dbQuery<{ id: string }>("organization", "create", {
    data: { name: `Fresh ${label}`, slug: testSlug(`portal-welcome-${label}`, runId) },
  });
  const owner = await dbQuery<{ id: string }>("user", "create", {
    data: { id: randomUUID(), email: testEmail(`portal-welcome-${label}-owner`, TEST_EMAIL_DOMAIN, runId), name: "Owner" },
  });
  await dbQuery("membership", "create", { data: { userId: owner.id, organizationId: org.id, role: "OWNER" } });
  const client = await dbQuery<{ id: string }>("client", "create", {
    data: { name: `Fresh ${label} Client`, organizationId: org.id, userId: owner.id },
  });
  const portalUser = await dbQuery<{ id: string; email: string }>("portalUser", "create", {
    data: {
      id: randomUUID(),
      clientId: client.id,
      email: testEmail(`portal-welcome-${label}-user`, TEST_EMAIL_DOMAIN, runId),
      name: "Fresh Portal User",
    },
  });
  return { client, portalUser };
}

let fixtures: TestFixtures;

test.beforeAll(async () => {
  fixtures = await seedE2EFixtures();
});

test.afterAll(async () => {
  await cleanupTestData(fixtures);
});

test.describe("Visibility and content", () => {
  test("a newly accepted PortalUser sees the welcome banner on /portal with accurate, real content", async ({
    context,
    baseURL,
    page,
  }) => {
    await actAsPortal(context, baseURL!, fixtures.portalUser);
    await gotoAndSettle(page, `${baseURL}/portal`);

    const banner = welcomeBanner(page);
    await expect(banner).toBeVisible();
    await expect(banner.getByText("View shared projects")).toBeVisible();
    await expect(banner.getByText("Review invoices")).toBeVisible();
    await expect(banner.getByText("Download files")).toBeVisible();
    await expect(banner.getByText("Manage your portal profile")).toBeVisible();
    await expect(banner.getByRole("link", { name: "View projects" })).toHaveAttribute("href", "/portal/projects");
    await expect(banner.getByRole("link", { name: "View invoices" })).toHaveAttribute("href", "/portal/invoices");
  });

  test("a PortalUser created more than 7 days ago no longer sees the banner", async ({ context, baseURL, page }) => {
    const oldUser = await dbQuery<{ id: string; email: string }>("portalUser", "create", {
      data: {
        id: randomUUID(),
        clientId: fixtures.clientA.id,
        email: testEmail("portal-welcome-old", TEST_EMAIL_DOMAIN, fixtures.runId),
        name: "Old Portal User",
        createdAt: new Date(Date.now() - SEVEN_DAYS_MS - 60 * 60 * 1000).toISOString(),
      },
    });

    await actAsPortal(context, baseURL!, oldUser);
    await gotoAndSettle(page, `${baseURL}/portal`);
    await expect(welcomeBanner(page)).toHaveCount(0);

    await dbQuery("portalUser", "delete", { where: { id: oldUser.id } });
  });
});

test.describe("CTA and dismiss", () => {
  test("'View projects' navigates to the real Projects page", async ({ context, baseURL, page }) => {
    await actAsPortal(context, baseURL!, fixtures.portalUser);
    await gotoAndSettle(page, `${baseURL}/portal`);
    await welcomeBanner(page).getByRole("link", { name: "View projects" }).click();
    await page.waitForURL(/\/portal\/projects$/);
  });

  test("dismissing hides the banner in place, without a manual page reload", async ({ context, baseURL, page }) => {
    await actAsPortal(context, baseURL!, fixtures.portalUser);
    await gotoAndSettle(page, `${baseURL}/portal`);

    await expect(welcomeBanner(page)).toBeVisible();
    await page.getByRole("button", { name: "Dismiss welcome message" }).click();
    await expect(welcomeBanner(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/portal$/);
  });

  test("focus moves to the page heading after dismiss, with a real visible focus indicator (Stage 6 audit fix)", async ({
    context,
    baseURL,
    page,
  }) => {
    await actAsPortal(context, baseURL!, fixtures.portalUser);
    await gotoAndSettle(page, `${baseURL}/portal`);

    const heading = page.getByRole("heading", { name: fixtures.clientA.name });
    expect(await hasVisibleFocusIndicator(heading)).toBe(false);

    await page.getByRole("button", { name: "Dismiss welcome message" }).click();
    await expect(heading).toBeFocused();
    expect(await hasVisibleFocusIndicator(heading)).toBe(true);
  });
});

test.describe("Empty-state coexistence", () => {
  test("existing Projects/Invoices empty states are untouched by the welcome banner", async ({
    context,
    baseURL,
    page,
  }) => {
    const fresh = await createFreshPortalIdentity(fixtures.runId, "empty");
    await actAsPortal(context, baseURL!, fresh.portalUser);

    await gotoAndSettle(page, `${baseURL}/portal`);
    await expect(welcomeBanner(page)).toBeVisible();

    await gotoAndSettle(page, `${baseURL}/portal/projects`);
    await expect(welcomeBanner(page)).toHaveCount(0);
    await expect(page.getByText("No projects yet")).toBeVisible();
    await expect(page.getByText("Projects will appear here once your team adds one.")).toBeVisible();

    await gotoAndSettle(page, `${baseURL}/portal/invoices`);
    await expect(welcomeBanner(page)).toHaveCount(0);
    await expect(page.getByText("No invoices", { exact: true })).toBeVisible();
    await expect(page.getByText("Invoices will appear here once your team creates one.")).toBeVisible();

    await dbQuery("portalUser", "delete", { where: { id: fresh.portalUser.id } });
    await dbQuery("client", "delete", { where: { id: fresh.client.id } });
  });
});

test.describe("Placement isolation", () => {
  test("no other Portal page shows the welcome banner", async ({ context, baseURL, page }) => {
    await actAsPortal(context, baseURL!, fixtures.portalUser);

    await gotoAndSettle(page, `${baseURL}/portal/projects`);
    await expect(welcomeBanner(page)).toHaveCount(0);

    await gotoAndSettle(page, `${baseURL}/portal/projects/${fixtures.project.id}`);
    await expect(welcomeBanner(page)).toHaveCount(0);

    await gotoAndSettle(page, `${baseURL}/portal/invoices`);
    await expect(welcomeBanner(page)).toHaveCount(0);

    // fixtures.invoice is DRAFT and, since Invoice System Official Slice 5
    // (docs/invoicing-architecture.md §10), a DRAFT invoice's Portal detail
    // page now correctly 404s — this check's own intent is "a real,
    // rendering Invoice detail page never shows the banner," so a
    // dedicated SENT invoice is used here instead of relying on the fixed
    // DRAFT-visibility bug.
    const visibleInvoice = await dbQuery<{ id: string }>("invoice", "create", {
      data: {
        invoiceNumber: `E2E-WELCOME-VISIBLE-${fixtures.runId}`,
        status: "SENT",
        amount: "10.00",
        projectId: fixtures.project.id,
        clientId: fixtures.clientA.id,
        organizationId: fixtures.orgA.id,
      },
    });
    await gotoAndSettle(page, `${baseURL}/portal/invoices/${visibleInvoice.id}`);
    await expect(welcomeBanner(page)).toHaveCount(0);
    await dbQuery("invoice", "deleteMany", { where: { id: visibleInvoice.id } });

    await gotoAndSettle(page, `${baseURL}/portal/profile`);
    await expect(welcomeBanner(page)).toHaveCount(0);
  });

  test("the Portal login page never shows the welcome banner", async ({ page, baseURL }) => {
    await gotoAndSettle(page, `${baseURL}/portal/login`);
    await expect(welcomeBanner(page)).toHaveCount(0);
  });

  test("the staff app has no Portal welcome banner and no staff onboarding checklist bleeds into it", async ({
    context,
    baseURL,
    page,
  }) => {
    await context.clearCookies();
    await injectTestSession(context, fixtures.owner, baseURL!);
    await context.addCookies([
      {
        name: "active_organization_id",
        value: fixtures.orgA.id,
        domain: new URL(baseURL!).hostname,
        path: "/",
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ]);
    await gotoAndSettle(page, `${baseURL}/dashboard`);
    await expect(welcomeBanner(page)).toHaveCount(0);
    await expect(page.getByText("Welcome to your client portal")).toHaveCount(0);
  });
});

test.describe("Mobile", () => {
  for (const width of [320, 360, 375, 390, 768]) {
    test(`the banner itself fits within ${width}px without its own horizontal overflow`, async ({
      context,
      baseURL,
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await actAsPortal(context, baseURL!, fixtures.portalUser);
      await gotoAndSettle(page, `${baseURL}/portal`);

      const banner = welcomeBanner(page);
      await expect(banner).toBeVisible();
      const box = await banner.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeLessThanOrEqual(width + 1);
      await expect(banner.getByRole("link", { name: "View projects" })).toBeVisible();
      await expect(banner.getByRole("button", { name: "Dismiss welcome message" })).toBeVisible();
    });
  }

  test("the banner still fits a short landscape phone viewport (812x375) without its own horizontal overflow", async ({
    context,
    baseURL,
    page,
  }) => {
    await page.setViewportSize({ width: 812, height: 375 });
    await actAsPortal(context, baseURL!, fixtures.portalUser);
    await gotoAndSettle(page, `${baseURL}/portal`);

    const banner = welcomeBanner(page);
    await expect(banner).toBeVisible();
    const box = await banner.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(812 + 1);
  });
});
