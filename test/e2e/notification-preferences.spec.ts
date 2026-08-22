import { test, expect, type BrowserContext } from "@playwright/test";
import { seedE2EFixtures, cleanupTestData, dbQuery, type TestFixtures } from "./fixtures";
import { injectTestSession } from "../support/e2e-session";

// I. Notification preferences — /settings/notifications. TEST_MODE gates a
// fake email "send" (see src/lib/email/resend-client.ts's TEST_MODE
// branch) so this can observe a real SENT outcome without ever reaching
// the real Resend API — no RESEND_API_KEY exists in this environment
// either way. Per-type formatter/allowlist behavior is already exhaustively
// unit/integration-tested; this file only covers the settings UI and its
// effect on real delivery outcomes.

async function setActiveOrg(context: BrowserContext, baseURL: string, organizationId: string): Promise<void> {
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

let fixtures: TestFixtures;

test.beforeAll(async () => {
  fixtures = await seedE2EFixtures();
});

test.afterAll(async () => {
  await cleanupTestData(fixtures);
});

test.afterEach(async () => {
  // Every test in this file mutates fixtures.member's role and/or
  // fixtures.member's own preference rows — restore both so later tests
  // (and afterAll's own cleanup) see the fixtures exactly as seeded.
  await dbQuery("notification", "deleteMany", { where: { organizationId: fixtures.orgA.id } });
  await dbQuery("activity", "deleteMany", { where: { organizationId: fixtures.orgA.id, action: "ROLE_CHANGED" } });
  await dbQuery("membership", "updateMany", {
    where: { userId: fixtures.member.id, organizationId: fixtures.orgA.id },
    data: { role: "MEMBER" },
  });
  await dbQuery("notificationPreference", "deleteMany", { where: { userId: fixtures.member.id } });
});

test("Settings page opens and lists every notification type with In-app/Email toggles", async ({
  context,
  baseURL,
  page,
}) => {
  await injectTestSession(context, { id: fixtures.owner.id, email: fixtures.owner.email }, baseURL!);
  await page.goto("/settings/notifications");

  await expect(page.getByRole("heading", { name: "Notification preferences" })).toBeVisible();
  await expect(page.getByText("Role changed", { exact: true })).toBeVisible();
  await expect(page.getByText("Invoice status changed", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "In-app notifications for Role changed" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Email notifications for Role changed" })).toBeChecked();
});

test("disabling email for a type SKIPs delivery for a real event; in-app is still visible; re-enabling SENDs the next one", async ({
  context,
  baseURL,
  page,
}) => {
  // 1. As the recipient (member), turn off email for ROLE_CHANGED.
  await injectTestSession(context, { id: fixtures.member.id, email: fixtures.member.email }, baseURL!);
  await setActiveOrg(context, baseURL!, fixtures.orgA.id);
  await page.goto("/settings/notifications");

  const emailToggle = page.getByRole("checkbox", { name: "Email notifications for Role changed" });
  await Promise.all([page.waitForResponse((r) => r.request().method() === "POST"), emailToggle.click()]);
  await expect(emailToggle).not.toBeChecked();

  // 2. As the owner, perform the real role change that targets member.
  await context.clearCookies();
  await injectTestSession(context, { id: fixtures.owner.id, email: fixtures.owner.email }, baseURL!);
  await page.goto("/team");
  const memberRow = page.getByRole("row", { name: new RegExp(fixtures.member.email) });
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST"),
    memberRow.getByLabel("Role").selectOption("ADMIN"),
  ]);

  const activity = await dbQuery<{ id: string }>("activity", "findFirstOrThrow", {
    where: { organizationId: fixtures.orgA.id, action: "ROLE_CHANGED" },
  });
  const notification = await dbQuery<{ id: string }>("notification", "findFirstOrThrow", {
    where: { activityId: activity.id },
  });
  const skippedDelivery = await dbQuery<{ status: string; failureCode: string | null }>(
    "notificationDelivery",
    "findUniqueOrThrow",
    { where: { notificationId_channel: { notificationId: notification.id, channel: "EMAIL" } } },
  );
  expect(skippedDelivery.status).toBe("SKIPPED");
  expect(skippedDelivery.failureCode).toBe("disabled_by_preference");

  // 3. In-app is entirely unaffected by the email preference — member still sees it.
  await context.clearCookies();
  await injectTestSession(context, { id: fixtures.member.id, email: fixtures.member.email }, baseURL!);
  await setActiveOrg(context, baseURL!, fixtures.orgA.id);
  await page.goto("/notifications");
  await expect(page.getByRole("list").getByText(`${fixtures.owner.name} changed your role`)).toBeVisible();

  // 4. Re-enable email for ROLE_CHANGED.
  await page.goto("/settings/notifications");
  const emailToggleAgain = page.getByRole("checkbox", { name: "Email notifications for Role changed" });
  await Promise.all([page.waitForResponse((r) => r.request().method() === "POST"), emailToggleAgain.click()]);
  await expect(emailToggleAgain).toBeChecked();

  // 5. Owner changes the role again (back to MEMBER) — a fresh ROLE_CHANGED event.
  await context.clearCookies();
  await injectTestSession(context, { id: fixtures.owner.id, email: fixtures.owner.email }, baseURL!);
  await page.goto("/team");
  const memberRowAgain = page.getByRole("row", { name: new RegExp(fixtures.member.email) });
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST"),
    memberRowAgain.getByLabel("Role").selectOption("MEMBER"),
  ]);

  const secondActivity = await dbQuery<{ id: string }>("activity", "findFirstOrThrow", {
    where: { organizationId: fixtures.orgA.id, action: "ROLE_CHANGED", id: { not: activity.id } },
  });
  const secondNotification = await dbQuery<{ id: string }>("notification", "findFirstOrThrow", {
    where: { activityId: secondActivity.id },
  });
  const sentDelivery = await dbQuery<{ status: string; deliveredAt: string | null }>(
    "notificationDelivery",
    "findUniqueOrThrow",
    { where: { notificationId_channel: { notificationId: secondNotification.id, channel: "EMAIL" } } },
  );
  expect(sentDelivery.status).toBe("SENT");
  expect(sentDelivery.deliveredAt).not.toBeNull();
});
