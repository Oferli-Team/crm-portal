import { test, expect } from "@playwright/test";
import { seedE2EFixtures, cleanupTestData, dbQuery, type TestFixtures } from "./fixtures";
import { injectTestSession } from "../support/e2e-session";

// F. Activity — a real UI action produces a visible /activity entry.
// Malformed-metadata handling is already covered by integration/unit
// tests (see src/lib/activity/format-activity.ts's FALLBACK path) and is
// deliberately not duplicated here.

let fixtures: TestFixtures;

test.beforeAll(async () => {
  fixtures = await seedE2EFixtures();
});

test.afterAll(async () => {
  await cleanupTestData(fixtures);
});

test.beforeEach(async ({ context, baseURL }) => {
  await injectTestSession(context, { id: fixtures.owner.id, email: fixtures.owner.email }, baseURL!);
});

test("a real UI action (creating a client) produces a visible entry on /activity", async ({ page }) => {
  const clientName = `E2E Activity Client ${fixtures.runId}`;

  try {
    await page.goto("/clients/new");
    // exact: true — the Client form's Billing details subsection (Invoice
    // System Slice 1) added a "Billing legal name" field whose accessible
    // name also contains "Name", making the default substring match
    // ambiguous.
    await page.getByRole("textbox", { name: "Name", exact: true }).fill(clientName);
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/clients/new") && r.request().method() === "POST"),
      page.getByRole("button", { name: "Create client" }).click(),
    ]);
    await expect(page).toHaveURL(/\/clients(\?|$)/);

    await page.goto("/activity");
    await expect(page.getByText(new RegExp(`created client ${clientName}`))).toBeVisible();
  } finally {
    await dbQuery("client", "deleteMany", { where: { name: clientName } });
  }
});
