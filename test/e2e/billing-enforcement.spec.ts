import { test, expect } from "@playwright/test";
import { seedE2EFixtures, cleanupTestData, dbQuery, type TestFixtures } from "./fixtures";
import { injectTestSession } from "../support/e2e-session";

/**
 * Billing & Subscriptions Stage 2 — deliberately one small, targeted E2E
 * test, not a full billing suite (no /settings/billing page exists yet in
 * this stage — see docs/billing-architecture.md's own Stage 2 scope). The
 * underlying enforcement logic itself already has thorough integration
 * coverage (test/integration/billing/); this test's only job is to prove
 * the full real stack — real form submission, real Server Action, real
 * BillingLimitError — renders a controlled, generic error in the existing
 * UI instead of a 500/crash page, for exactly one representative
 * enforcement point (Client creation). The other three call sites
 * (invite, Project, Attachment) share the identical assertCan-helper,
 * BillingLimitError, catch-and-return-error shape, already unit- and
 * integration-tested individually.
 */

let fixtures: TestFixtures;

test.beforeAll(async () => {
  fixtures = await seedE2EFixtures();

  // A STARTER subscription (maxClients: 10) with exactly 10 clients
  // already at the limit — the owner (fixtures.owner) already counts as
  // the STARTER plan's 1 member, so this deliberately only exercises the
  // client limit, not the member one.
  await dbQuery("subscription", "create", {
    data: {
      organizationId: fixtures.orgA.id,
      planKey: "STARTER",
      status: "ACTIVE",
      trialStartedAt: new Date().toISOString(),
      trialEndsAt: new Date().toISOString(),
    },
  });

  const extraClients = Array.from({ length: 9 }, (_, i) => ({
    name: `BILLING-E2E-LimitClient-${i}-${fixtures.runId}`,
    userId: fixtures.owner.id,
    organizationId: fixtures.orgA.id,
  }));
  // fixtures.clientA already exists under orgA — 9 more brings the total to 10.
  await dbQuery("client", "createMany", { data: extraClients });
});

test.afterAll(async () => {
  await dbQuery("client", "deleteMany", { where: { name: { startsWith: `BILLING-E2E-LimitClient-` } } });
  await dbQuery("subscription", "deleteMany", { where: { organizationId: fixtures.orgA.id } });
  await cleanupTestData(fixtures);
});

test.beforeEach(async ({ context, baseURL }) => {
  await injectTestSession(context, { id: fixtures.owner.id, email: fixtures.owner.email }, baseURL!);
});

test("creating a Client past the plan's limit shows a controlled, generic error — never a 500 or crash page", async ({ page }) => {
  await page.goto("/clients/new");
  // exact: true — the Client form's Billing details subsection (Invoice
  // System Slice 1) added a "Billing legal name" field, making the
  // default substring match for "Name" ambiguous.
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(`BILLING-E2E-ShouldBeBlocked-${fixtures.runId}`);
  await page.getByRole("button", { name: "Create client" }).click();

  await expect(page.getByText("Your plan's client limit has been reached.")).toBeVisible();

  // Never a raw error page, never a stack trace, never a provider-shaped message.
  await expect(page.getByText(/internal server error/i)).toHaveCount(0);
  await expect(page.getByText(/prisma/i)).toHaveCount(0);
  await expect(page).toHaveURL(/\/clients\/new/);

  // The blocked submission never actually created the row.
  const stillTen = await dbQuery("client", "count", { where: { organizationId: fixtures.orgA.id } });
  expect(stillTen).toBe(10);
});
