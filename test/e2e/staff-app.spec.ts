import { test, expect } from "@playwright/test";
import { seedE2EFixtures, cleanupTestData, dbQuery, type TestFixtures } from "./fixtures";
import { injectTestSession } from "../support/e2e-session";

// A. Staff application — session injection (see test/support/e2e-session.ts
// and src/lib/test-mode.ts for why: no real Supabase Auth is available
// locally), dashboard access, sidebar navigation, a real Client create →
// edit → delete cycle through the actual UI/Server Actions, the dashboard
// metric reacting to that, and logout / no-session redirect.

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

test("dashboard opens for an injected staff session", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible();
});

test("sidebar navigation reaches every staff section", async ({ page }) => {
  await page.goto("/dashboard");
  const nav = page.getByRole("navigation", { name: "Primary" });

  for (const [label, path] of [
    ["Clients", "/clients"],
    ["Projects", "/projects"],
    ["Tasks", "/tasks"],
    ["Invoices", "/invoices"],
    ["Team", "/team"],
    ["Activity", "/activity"],
  ] as const) {
    await nav.getByRole("link", { name: label }).click();
    await expect(page).toHaveURL(new RegExp(path.replace("/", "\\/")));
  }
});

test("Client create → edit → delete works end to end, and the dashboard metric reflects it", async ({ page }) => {
  await page.goto("/dashboard");
  const totalClientsCard = page.getByRole("link", { name: /total clients/i });
  const before = Number((await totalClientsCard.locator("p").nth(1).innerText()).trim());

  // Create.
  await page.goto("/clients/new");
  const clientName = `E2E Test Client ${fixtures.runId}`;
  // exact: true — the Client form's Billing details subsection (Invoice
  // System Slice 1) added a "Billing legal name" field, making the
  // default substring match for "Name" ambiguous.
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(clientName);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/clients/new") && r.request().method() === "POST"),
    page.getByRole("button", { name: "Create client" }).click(),
  ]);
  await expect(page).toHaveURL(/\/clients(\?|$)/);

  const createdRow = page.getByRole("row", { name: new RegExp(clientName) });
  await expect(createdRow).toBeVisible();

  const created = await dbQuery<{ id: string }>("client", "findFirstOrThrow", { where: { name: clientName } });

  try {
    // Dashboard metric increased by exactly one.
    await page.goto("/dashboard");
    const after = Number((await totalClientsCard.locator("p").nth(1).innerText()).trim());
    expect(after).toBe(before + 1);

    // Edit.
    await page.goto("/clients");
    await createdRow.getByRole("link", { name: "Edit" }).click();
    await expect(page).toHaveURL(new RegExp(`/clients/${created.id}/edit`));
    const updatedName = `${clientName} (updated)`;
    await page.getByRole("textbox", { name: "Name", exact: true }).fill(updatedName);
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST"),
      page.getByRole("button", { name: "Save changes" }).click(),
    ]);
    const updated = await dbQuery<{ name: string }>("client", "findUniqueOrThrow", { where: { id: created.id } });
    expect(updated.name).toBe(updatedName);

    // Delete (real confirmation dialog).
    await page.goto("/clients");
    const updatedRow = page.getByRole("row", { name: new RegExp(updatedName.replace(/[().]/g, "\\$&")) });
    await updatedRow.getByRole("button", { name: "Delete" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST"),
      dialog.getByRole("button", { name: "Delete" }).click(),
    ]);

    const gone = await dbQuery("client", "findUnique", { where: { id: created.id } });
    expect(gone).toBeNull();

    // Dashboard metric back to its original value.
    await page.goto("/dashboard");
    const restored = Number((await totalClientsCard.locator("p").nth(1).innerText()).trim());
    expect(restored).toBe(before);
  } finally {
    // If an assertion above throws, the client this test created would
    // otherwise survive into afterAll's cleanupTestData — which only
    // targets the originally-seeded fixture IDs — and then block deleting
    // the owning User via Client_userId_fkey's RESTRICT, breaking every
    // later test's seed/cleanup in the same run.
    await dbQuery("client", "deleteMany", { where: { id: created.id } });
  }
});

test("sign out clears the session, and dashboard then redirects to /login", async ({ page }) => {
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login/);

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
});

test("visiting a protected page with no session redirects to /login", async ({ context, baseURL }) => {
  // A fresh context with no injected session at all.
  const freshContext = await context.browser()!.newContext();
  const freshPage = await freshContext.newPage();
  await freshPage.goto(`${baseURL}/dashboard`);
  await expect(freshPage).toHaveURL(/\/login/);
  await freshContext.close();
});
