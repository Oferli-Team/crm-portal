import { test, expect, type BrowserContext } from "@playwright/test";
import { seedE2EFixtures, cleanupTestData, dbQuery, type TestFixtures } from "./fixtures";
import { injectTestSession } from "../support/e2e-session";

/**
 * Billing & Subscriptions Stage 3 (this stage's own §18). One focused
 * billing UI spec against the real running app/database — no external
 * payment API calls anywhere in this file (there is nothing to call; no
 * provider is connected).
 */

let fixtures: TestFixtures;

test.beforeAll(async () => {
  fixtures = await seedE2EFixtures();
});

test.afterAll(async () => {
  await cleanupTestData(fixtures);
});

/**
 * injectTestSession() alone only sets the identity cookie — with no
 * active_organization_id cookie, resolveActiveOrganizationId() (src/lib/
 * current-user.ts) falls back to the caller's own OWNER org, silently
 * auto-provisioning a brand-new personal workspace for any identity that
 * isn't an OWNER anywhere (exactly what fixtures.admin/fixtures.member
 * are in orgA). Every test in this file must act against fixtures.orgA
 * specifically, so every identity switch goes through this helper — same
 * pattern as test/e2e/global-search.spec.ts's own actAsMember.
 */
async function actAsMember(
  context: BrowserContext,
  baseURL: string,
  user: { id: string; email: string },
  organizationId: string,
): Promise<void> {
  await context.clearCookies();
  await injectTestSession(context, user, baseURL);
  await context.addCookies([
    {
      name: "active_organization_id",
      value: organizationId,
      domain: new URL(baseURL).hostname,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

async function setSubscription(organizationId: string, overrides: Record<string, unknown> = {}) {
  await dbQuery("subscription", "deleteMany", { where: { organizationId } });
  const now = new Date().toISOString();
  await dbQuery("subscription", "create", {
    data: {
      organizationId,
      planKey: "STARTER",
      status: "ACTIVE",
      trialStartedAt: now,
      trialEndsAt: now,
      ...overrides,
    },
  });
}

async function clearSubscription(organizationId: string) {
  await dbQuery("subscription", "deleteMany", { where: { organizationId } });
}

test.describe("OWNER", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
  });

  test.afterEach(async () => {
    await clearSubscription(fixtures.orgA.id);
  });

  test("Billing link is visible in the sidebar and navigates to the Billing page", async ({ page }) => {
    await page.goto("/dashboard");
    const nav = page.getByRole("navigation", { name: "Primary" });
    await nav.getByRole("link", { name: "Billing" }).click();
    await expect(page).toHaveURL(/\/settings\/billing/);
    await expect(page.getByRole("heading", { name: "Billing", level: 1 })).toBeVisible();
  });

  test("shows current plan, status, usage rows, and plan cards", async ({ page }) => {
    await setSubscription(fixtures.orgA.id, { planKey: "STARTER", status: "ACTIVE" });
    await page.goto("/settings/billing");

    await expect(page.getByRole("heading", { name: "Starter", level: 2 })).toBeVisible();
    await expect(page.getByText("Active", { exact: true })).toBeVisible();

    // Scoped to the Usage region — "Clients"/"Projects" also appear as
    // Sidebar nav links elsewhere on the page.
    const usage = page.getByRole("region", { name: "Usage" });
    await expect(usage.getByText("Members", { exact: true })).toBeVisible();
    await expect(usage.getByText("Clients", { exact: true })).toBeVisible();
    await expect(usage.getByText("Projects", { exact: true })).toBeVisible();
    await expect(usage.getByText("Storage", { exact: true })).toBeVisible();

    await expect(page.getByRole("heading", { name: "Plans" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pro", level: 3 })).toBeVisible();
  });

  // Billing & Subscriptions Stage 4: TEST_MODE (set for this whole E2E
  // run — see playwright.config.ts's webServer.env) now resolves the
  // provider registry to the real MockBillingProvider, so Upgrade/Manage
  // navigate to a real mock checkout/portal session instead of showing
  // Stage 3's "not configured" toast. The full mock checkout → webhook →
  // updated-plan flow, and the "not configured" copy for a genuinely
  // unconfigured provider, are covered in test/e2e/billing-mock-flow.spec.ts.
  test("Upgrade action navigates to the mock checkout page for the selected plan", async ({ page }) => {
    await setSubscription(fixtures.orgA.id, { planKey: "STARTER", status: "ACTIVE" });
    await page.goto("/settings/billing");

    await page.getByRole("button", { name: "Upgrade" }).click();

    await expect(page).toHaveURL(/\/billing\/mock\/checkout/);
    await expect(page.getByText("Mock checkout — TEST_MODE only")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Subscribe to Pro" })).toBeVisible();
  });

  test("Manage subscription with no billing account yet shows a controlled message", async ({ page }) => {
    await setSubscription(fixtures.orgA.id, { planKey: "STARTER", status: "ACTIVE" });
    await page.goto("/settings/billing");

    await page.getByRole("button", { name: "Manage subscription" }).click();
    await expect(page.getByText("There's no billing account to manage yet")).toBeVisible();
    await expect(page).toHaveURL(/\/settings\/billing/);
  });
});

test.describe("ADMIN and MEMBER", () => {
  for (const roleLabel of ["admin", "member"] as const) {
    test(`${roleLabel}: sees a read-only summary; management actions are disabled with an explanation`, async ({
      page,
      context,
      baseURL,
    }) => {
      const identity = fixtures[roleLabel];
      await actAsMember(context, baseURL!, identity, fixtures.orgA.id);
      await setSubscription(fixtures.orgA.id, { planKey: "STARTER", status: "ACTIVE" });

      try {
        await page.goto("/settings/billing");
        await expect(page.getByRole("heading", { name: "Billing", level: 1 })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Starter", level: 2 })).toBeVisible();

        await expect(page.getByRole("button", { name: "Manage subscription" })).toBeDisabled();
        await expect(page.getByRole("button", { name: "Upgrade" })).toBeDisabled();
        await expect(page.getByText("Only the organization owner can manage billing.").first()).toBeVisible();
      } finally {
        await clearSubscription(fixtures.orgA.id);
      }
    });
  }
});

test.describe("Plan/status states", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
  });

  test.afterEach(async () => {
    await clearSubscription(fixtures.orgA.id);
  });

  test("trial state shows a trial countdown notice", async ({ page }) => {
    await setSubscription(fixtures.orgA.id, {
      planKey: "TRIAL",
      status: "TRIALING",
      trialEndsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await page.goto("/settings/billing");
    await expect(page.getByText(/Trial ends in/)).toBeVisible();
  });

  test("legacy state (no Subscription row) shows unrestricted-access copy, never a crash", async ({ page }) => {
    await clearSubscription(fixtures.orgA.id);
    await page.goto("/settings/billing");
    await expect(page.getByText("This workspace uses legacy unrestricted access.")).toBeVisible();
    await expect(page.getByText(/internal server error/i)).toHaveCount(0);
  });

  test("past_due past its grace period shows the read-only access-mode banner, and the page still fully renders", async ({ page }) => {
    await setSubscription(fixtures.orgA.id, {
      planKey: "STARTER",
      status: "PAST_DUE",
      gracePeriodEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    await page.goto("/settings/billing");
    await expect(page.getByText(/read-only/i).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Plans" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Usage" })).toBeVisible();
  });

  test("over-limit usage shows an 'Over limit' tag, never hidden or destructive", async ({ page }) => {
    await setSubscription(fixtures.orgA.id, { planKey: "STARTER", status: "ACTIVE" });
    const extraClients = Array.from({ length: 10 }, (_, i) => ({
      name: `BILLING-UI-E2E-OverLimitClient-${i}-${fixtures.runId}`,
      userId: fixtures.owner.id,
      organizationId: fixtures.orgA.id,
    }));
    await dbQuery("client", "createMany", { data: extraClients });

    try {
      await page.goto("/settings/billing");
      await expect(page.getByText("Over limit").first()).toBeVisible();
    } finally {
      await dbQuery("client", "deleteMany", { where: { name: { startsWith: "BILLING-UI-E2E-OverLimitClient-" } } });
    }
  });

  test("an unrecognized plan key in the database is safely normalized (never a crash), with a consistent Legacy status — not a stale 'Active' badge (Stage 5 audit fix)", async ({ page }) => {
    // buildOrganizationEntitlements (src/lib/billing/entitlements.ts, Stage
    // 2) already normalizes any Subscription.planKey it doesn't recognize
    // to LEGACY before the view-model ever sees it — so a real DB row like
    // this one renders as the Legacy plan, not the view-model's own
    // "Custom plan" fallback (that fallback is defense-in-depth for a
    // hypothetical caller that bypasses entitlements entirely; see
    // test/unit/billing-view-model.test.ts's own "unknown plan key" case).
    // The real, end-to-end guarantee this test exists to prove: the page
    // renders a safe label and never crashes — AND (Stage 5 audit fix)
    // the status badge/message next to that label is internally
    // consistent with it, never a leftover "Active" from the row's own
    // real `status` field (this row's `status: "ACTIVE"` is exactly what
    // prisma/backfill-subscriptions.ts itself writes for a legacy org).
    await setSubscription(fixtures.orgA.id, { planKey: "MYSTERY_PLAN", status: "ACTIVE" });
    await page.goto("/settings/billing");
    await expect(page.getByRole("heading", { name: "Legacy (pre-billing)", level: 2 })).toBeVisible();
    await expect(page.getByText(/internal server error/i)).toHaveCount(0);
    await expect(page.getByText("This workspace uses legacy unrestricted access.")).toBeVisible();
    await expect(page.getByText("Active", { exact: true })).toHaveCount(0);
  });
});

test.describe("Client Portal", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await injectTestSession(context, { id: fixtures.portalUser.id, email: fixtures.portalUser.email }, baseURL!);
  });

  test("no Billing link in the portal nav, and the staff billing route redirects away", async ({ page }) => {
    await page.goto("/portal");
    await expect(page.getByRole("link", { name: "Billing" })).toHaveCount(0);

    await page.goto("/settings/billing");
    await expect(page).toHaveURL(/\/portal$/);
  });
});

test.describe("Mobile", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test.beforeEach(async ({ context, baseURL }) => {
    await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
  });

  test.afterEach(async () => {
    await clearSubscription(fixtures.orgA.id);
  });

  test("Billing page renders usably on a small viewport", async ({ page }) => {
    await setSubscription(fixtures.orgA.id, { planKey: "STARTER", status: "ACTIVE" });
    await page.goto("/settings/billing");
    await expect(page.getByRole("heading", { name: "Billing", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Starter", level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Plans" })).toBeVisible();
  });
});
