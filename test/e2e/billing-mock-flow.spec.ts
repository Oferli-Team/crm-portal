import { test, expect, type BrowserContext } from "@playwright/test";
import { seedE2EFixtures, cleanupTestData, dbQuery, type TestFixtures } from "./fixtures";
import { injectTestSession } from "../support/e2e-session";

/**
 * Billing & Subscriptions Stage 4 (this stage's own §19). The full,
 * real-browser mock flow: checkout → real webhook route → updated plan on
 * the Billing page; the mock Customer Portal's simulated cancel/past-due
 * events, each also round-tripping through the real webhook route. No
 * external payment API calls anywhere (there is nothing to call — the
 * mock never leaves this app's own process). TEST_MODE is on for this
 * whole E2E run (playwright.config.ts's webServer.env), which is exactly
 * what makes the mock provider reachable at all.
 */

let fixtures: TestFixtures;

test.beforeAll(async () => {
  fixtures = await seedE2EFixtures();
});

test.afterAll(async () => {
  await cleanupTestData(fixtures);
});

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

async function clearSubscription(organizationId: string) {
  await dbQuery("subscription", "deleteMany", { where: { organizationId } });
}

test.describe("OWNER — full mock checkout → webhook → Billing page flow", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
  });

  test.afterEach(async () => {
    await clearSubscription(fixtures.orgA.id);
  });

  test("Upgrade → mock checkout → Complete purchase → webhook fires → Billing page shows the new plan as Active", async ({ page }) => {
    await clearSubscription(fixtures.orgA.id); // LEGACY start — no Subscription row yet
    await page.goto("/settings/billing");

    await page.getByRole("button", { name: "Upgrade" }).nth(0).click();
    await expect(page).toHaveURL(/\/billing\/mock\/checkout/);
    await expect(page.getByRole("heading", { name: /Subscribe to/ })).toBeVisible();

    await page.getByRole("button", { name: "Complete purchase" }).click();

    await expect(page).toHaveURL(/\/settings\/billing\?checkout=success/);
    await expect(page.getByRole("heading", { name: "Legacy (pre-billing)" })).toHaveCount(0);
    await expect(page.getByText("Active", { exact: true })).toBeVisible();

    const subscription = await dbQuery<{ status: string; providerCustomerId: string | null }>("subscription", "findUnique", {
      where: { organizationId: fixtures.orgA.id },
    });
    expect(subscription?.status).toBe("ACTIVE");
    expect(subscription?.providerCustomerId).not.toBeNull();
  });

  test("Cancel on the mock checkout page returns to Billing with no Subscription change", async ({ page }) => {
    await clearSubscription(fixtures.orgA.id);
    await page.goto("/settings/billing");

    await page.getByRole("button", { name: "Upgrade" }).nth(0).click();
    await expect(page).toHaveURL(/\/billing\/mock\/checkout/);

    await page.getByRole("link", { name: "Cancel and return" }).click();
    await expect(page).toHaveURL(/\/settings\/billing\?checkout=cancel/);
    await expect(page.getByText("Checkout was canceled")).toBeVisible();

    const subscription = await dbQuery("subscription", "findUnique", { where: { organizationId: fixtures.orgA.id } });
    expect(subscription).toBeNull();
  });

  test("Manage subscription → mock portal → simulate payment failure → webhook fires → Billing page shows past_due", async ({ page }) => {
    const now = new Date().toISOString();
    await dbQuery("subscription", "create", {
      data: {
        organizationId: fixtures.orgA.id,
        planKey: "STARTER",
        status: "ACTIVE",
        providerCustomerId: `mock_cus_${fixtures.orgA.id}`,
        providerSubscriptionId: `mock_sub_${fixtures.orgA.id}`,
        trialStartedAt: now,
        trialEndsAt: now,
      },
    });

    await page.goto("/settings/billing");
    await page.getByRole("button", { name: "Manage subscription" }).click();
    await expect(page).toHaveURL(/\/billing\/mock\/portal/);

    await page.getByRole("button", { name: "Simulate payment failure" }).click();

    await expect(page).toHaveURL(/\/settings\/billing/);
    await expect(page.getByText(/Payment is past due/i).first()).toBeVisible();

    const subscription = await dbQuery<{ status: string }>("subscription", "findUnique", { where: { organizationId: fixtures.orgA.id } });
    expect(subscription?.status).toBe("PAST_DUE");
  });

  test("Manage subscription → mock portal → simulate cancel → webhook fires → Billing page reflects cancellation", async ({ page }) => {
    const now = new Date().toISOString();
    await dbQuery("subscription", "create", {
      data: {
        organizationId: fixtures.orgA.id,
        planKey: "STARTER",
        status: "ACTIVE",
        currentPeriodStart: now,
        currentPeriodEnd: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
        providerCustomerId: `mock_cus_${fixtures.orgA.id}`,
        providerSubscriptionId: `mock_sub_${fixtures.orgA.id}`,
        trialStartedAt: now,
        trialEndsAt: now,
      },
    });

    await page.goto("/settings/billing");
    await page.getByRole("button", { name: "Manage subscription" }).click();
    await expect(page).toHaveURL(/\/billing\/mock\/portal/);

    await page.getByRole("button", { name: "Simulate cancel" }).click();

    await expect(page).toHaveURL(/\/settings\/billing/);

    const subscription = await dbQuery<{ status: string; cancelAtPeriodEnd: boolean }>("subscription", "findUnique", {
      where: { organizationId: fixtures.orgA.id },
    });
    expect(subscription?.status).toBe("CANCELED");
    expect(subscription?.cancelAtPeriodEnd).toBe(true);
  });
});

test.describe("ADMIN and MEMBER cannot reach the mock checkout/portal pages directly", () => {
  for (const roleLabel of ["admin", "member"] as const) {
    test(`${roleLabel}: direct navigation to /billing/mock/checkout for org A is refused`, async ({ page, context, baseURL }) => {
      const identity = fixtures[roleLabel];
      await actAsMember(context, baseURL!, identity, fixtures.orgA.id);

      const response = await page.goto(
        `/billing/mock/checkout?organizationId=${fixtures.orgA.id}&planKey=PRO&returnUrl=/settings/billing&cancelUrl=/settings/billing`,
      );
      expect(response?.status()).toBe(404);
    });
  }
});

test.describe("Client Portal — still no billing access after Stage 4", () => {
  test("portal identity cannot reach the mock checkout/portal pages either", async ({ page, context, baseURL }) => {
    await injectTestSession(context, { id: fixtures.portalUser.id, email: fixtures.portalUser.email }, baseURL!);
    await page.goto(
      `/billing/mock/checkout?organizationId=${fixtures.orgA.id}&planKey=PRO&returnUrl=/settings/billing&cancelUrl=/settings/billing`,
    );
    await expect(page).toHaveURL(/\/portal$/);
  });
});
