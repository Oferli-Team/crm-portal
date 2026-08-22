import { test, expect, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { seedE2EFixtures, cleanupTestData, dbQuery, type TestFixtures } from "./fixtures";
import { injectTestSession } from "../support/e2e-session";

// H. The full /notifications inbox — tabs, pagination, mark-one/mark-all,
// org isolation, and the bell's "View all notifications" link. Per-type
// formatter text is already exhaustively unit-tested
// (test/unit/format-notification.test.ts) and isn't repeated here; only
// ROLE_CHANGED is used throughout as a representative stand-in.

const BELL = 'summary[aria-label^="Notifications"]';

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

function roleChangedNotification(organizationId: string, recipientId: string, overrides: Partial<{ readAt: Date }> = {}) {
  return dbQuery<{ id: string }>("notification", "create", {
    data: {
      organizationId,
      recipientId,
      type: "ROLE_CHANGED",
      metadata: { actorName: "Jane Doe", from: "MEMBER", to: "ADMIN" },
      ...(overrides.readAt ? { readAt: overrides.readAt } : {}),
    },
  });
}

let fixtures: TestFixtures;

test.beforeAll(async () => {
  fixtures = await seedE2EFixtures();
});

test.afterAll(async () => {
  await cleanupTestData(fixtures);
});

test("the bell's 'View all notifications' link opens the real /notifications page", async ({
  context,
  baseURL,
  page,
}) => {
  await injectTestSession(context, { id: fixtures.owner.id, email: fixtures.owner.email }, baseURL!);
  await page.goto("/dashboard");

  await page.locator(BELL).click();
  await page.getByRole("link", { name: "View all notifications" }).click();

  await expect(page).toHaveURL(/\/notifications$/);
  // A client-side Link navigation to a route this run has never rendered
  // before goes through loading.tsx's Suspense fallback first (plain
  // Skeleton divs, no accessible name) while the page's own data fetch
  // resolves — under this sandbox's shared CPU that can occasionally take
  // longer than the default 5s assertion timeout, so this one waits longer
  // rather than treating normal Suspense latency as a failure.
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible({ timeout: 15_000 });
});

test("a portal-only identity has no access to /notifications", async ({ context, baseURL, page }) => {
  await injectTestSession(context, { id: fixtures.portalUser.id, email: fixtures.portalUser.email }, baseURL!);
  await page.goto("/notifications");
  await expect(page).toHaveURL(/\/portal$/);
});

test("All/Unread tabs filter the list, with aria-current marking the active one", async ({
  context,
  baseURL,
  page,
}) => {
  const unread = await roleChangedNotification(fixtures.orgA.id, fixtures.admin.id);
  const read = await roleChangedNotification(fixtures.orgA.id, fixtures.admin.id, { readAt: new Date() });

  try {
    await injectTestSession(context, { id: fixtures.admin.id, email: fixtures.admin.email }, baseURL!);
    await setActiveOrg(context, baseURL!, fixtures.orgA.id);
    await page.goto("/notifications");

    const allTab = page.getByRole("link", { name: "All" });
    const unreadTab = page.getByRole("link", { name: /^Unread/ });
    await expect(allTab).toHaveAttribute("aria-current", "page");

    const list = page.getByRole("list");
    await expect(list.getByText("Jane Doe changed your role")).toHaveCount(2);

    await unreadTab.click();
    await expect(page).toHaveURL(/filter=unread/);
    await expect(unreadTab).toHaveAttribute("aria-current", "page");
    await expect(list.getByText("Jane Doe changed your role")).toHaveCount(1);
  } finally {
    await dbQuery("notification", "deleteMany", { where: { id: { in: [unread.id, read.id] } } });
  }
});

test("marking one notification read from the Unread tab removes it there, but it still shows under All", async ({
  context,
  baseURL,
  page,
}) => {
  const a = await roleChangedNotification(fixtures.orgA.id, fixtures.member.id);
  const b = await roleChangedNotification(fixtures.orgA.id, fixtures.member.id);

  try {
    await injectTestSession(context, { id: fixtures.member.id, email: fixtures.member.email }, baseURL!);
    await setActiveOrg(context, baseURL!, fixtures.orgA.id);
    await page.goto("/notifications?filter=unread");

    const list = page.getByRole("list");
    await expect(list.getByText("Jane Doe changed your role")).toHaveCount(2);

    // ROLE_CHANGED links to /team, so the first row's click marks-and-navigates
    // (Variant A) — reload back to the same filtered view afterward to see
    // the settled server state rather than racing the two independent requests.
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST"),
      list.getByText("Jane Doe changed your role").first().click(),
    ]);
    await expect(page).toHaveURL(/\/team/);

    await page.goto("/notifications?filter=unread");
    await expect(page.getByRole("list").getByText("Jane Doe changed your role")).toHaveCount(1);

    await page.goto("/notifications"); // All
    await expect(page.getByRole("list").getByText("Jane Doe changed your role")).toHaveCount(2);
  } finally {
    await dbQuery("notification", "deleteMany", { where: { id: { in: [a.id, b.id] } } });
  }
});

test("Mark all as read empties the Unread tab, keeps the rows under All, and clears the bell badge", async ({
  context,
  baseURL,
  page,
}) => {
  const disposableUser = await dbQuery<{ id: string; email: string }>("user", "create", {
    data: { id: randomUUID(), email: `e2e-inbox-markall-${fixtures.runId}@e2e.test.local`, name: "Mark All E2E" },
  });
  await dbQuery("membership", "create", {
    data: { userId: disposableUser.id, organizationId: fixtures.orgA.id, role: "MEMBER" },
  });
  const a = await roleChangedNotification(fixtures.orgA.id, disposableUser.id);
  const b = await roleChangedNotification(fixtures.orgA.id, disposableUser.id);

  try {
    await injectTestSession(context, { id: disposableUser.id, email: disposableUser.email }, baseURL!);
    await setActiveOrg(context, baseURL!, fixtures.orgA.id);
    await page.goto("/notifications");

    await expect(page.locator(BELL)).toHaveAttribute("aria-label", /2 unread/);
    await expect(page.getByRole("button", { name: "Mark all as read" })).toBeVisible();

    await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST"),
      page.getByRole("button", { name: "Mark all as read" }).click(),
    ]);

    await expect(page.getByRole("button", { name: "Mark all as read" })).toHaveCount(0);
    await expect(page.locator(BELL)).toHaveAttribute("aria-label", "Notifications");

    await page.goto("/notifications?filter=unread");
    await expect(page.getByText("You're all caught up.")).toBeVisible();

    await page.goto("/notifications"); // All — rows persist, just no longer unread
    await expect(page.getByRole("list").getByText("Jane Doe changed your role")).toHaveCount(2);
  } finally {
    await dbQuery("notification", "deleteMany", { where: { id: { in: [a.id, b.id] } } });
    await dbQuery("membership", "deleteMany", { where: { userId: disposableUser.id } });
    await dbQuery("user", "delete", { where: { id: disposableUser.id } });
  }
});

test("more than 25 notifications shows a Load more link that reaches every row", async ({
  context,
  baseURL,
  page,
}) => {
  const rows = await Promise.all(
    Array.from({ length: 26 }, (_, i) =>
      dbQuery<{ id: string }>("notification", "create", {
        data: {
          organizationId: fixtures.orgA.id,
          recipientId: fixtures.owner.id,
          type: "ROLE_CHANGED",
          metadata: { actorName: `Actor ${i}`, from: "MEMBER", to: "ADMIN" },
          createdAt: new Date(Date.now() - i * 1000).toISOString(),
        },
      }),
    ),
  );

  try {
    await injectTestSession(context, { id: fixtures.owner.id, email: fixtures.owner.email }, baseURL!);
    await page.goto("/notifications");

    const list = page.getByRole("list");
    await expect(list.getByRole("listitem")).toHaveCount(25);
    const loadMore = page.getByRole("link", { name: "Load more" });
    await expect(loadMore).toBeVisible();

    // Forward-only cursor navigation, not client-side accumulation — page 2
    // is a fresh server render showing only its own (remaining) row.
    await loadMore.click();
    await expect(page).toHaveURL(/cursor=/);
    await expect(page.getByRole("list").getByRole("listitem")).toHaveCount(1);
    await expect(page.getByRole("link", { name: "Load more" })).toHaveCount(0);
  } finally {
    await dbQuery("notification", "deleteMany", { where: { id: { in: rows.map((r) => r.id) } } });
  }
});

test("switching organizations changes the /notifications inbox", async ({ context, baseURL, page }) => {
  const dualOrgUser = await dbQuery<{ id: string; email: string }>("user", "create", {
    data: { id: randomUUID(), email: `e2e-inbox-dual-org-${fixtures.runId}@e2e.test.local`, name: "Inbox Dual Org" },
  });
  await dbQuery("membership", "createMany", {
    data: [
      { userId: dualOrgUser.id, organizationId: fixtures.orgA.id, role: "MEMBER" },
      { userId: dualOrgUser.id, organizationId: fixtures.orgB.id, role: "MEMBER" },
    ],
  });
  const inA = await dbQuery<{ id: string }>("notification", "create", {
    data: {
      organizationId: fixtures.orgA.id,
      recipientId: dualOrgUser.id,
      type: "ROLE_CHANGED",
      metadata: { actorName: "Org A Actor", from: "MEMBER", to: "ADMIN" },
    },
  });
  const inB = await dbQuery<{ id: string }>("notification", "create", {
    data: {
      organizationId: fixtures.orgB.id,
      recipientId: dualOrgUser.id,
      type: "MEMBER_REMOVED",
      metadata: { actorName: "Org B Actor", memberName: "Someone Else" },
    },
  });

  try {
    await injectTestSession(context, { id: dualOrgUser.id, email: dualOrgUser.email }, baseURL!);
    await setActiveOrg(context, baseURL!, fixtures.orgA.id);
    await page.goto("/notifications");

    const list = page.getByRole("list");
    await expect(list.getByText("Org A Actor changed your role")).toBeVisible();
    await expect(list.getByText("Org B Actor removed you from the organization")).toHaveCount(0);

    await page.locator("summary", { hasText: "Test Org A" }).click();
    await Promise.all([
      page.waitForURL(/\/dashboard/),
      page.getByRole("button", { name: /Test Org B/ }).click(),
    ]);

    await page.goto("/notifications");
    const listAfter = page.getByRole("list");
    await expect(listAfter.getByText("Org B Actor removed you from the organization")).toBeVisible();
    await expect(listAfter.getByText("Org A Actor changed your role")).toHaveCount(0);
  } finally {
    await dbQuery("notification", "deleteMany", { where: { id: { in: [inA.id, inB.id] } } });
    await dbQuery("membership", "deleteMany", { where: { userId: dualOrgUser.id } });
    await dbQuery("user", "delete", { where: { id: dualOrgUser.id } });
  }
});

test("malformed metadata renders a safe fallback on the full page instead of crashing it", async ({
  context,
  baseURL,
  page,
}) => {
  const good = await roleChangedNotification(fixtures.orgA.id, fixtures.admin.id);
  const malformed = await dbQuery<{ id: string }>("notification", "create", {
    data: {
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.admin.id,
      type: "INVOICE_STATUS_CHANGED",
      metadata: { unexpected: 12345 },
    },
  });

  try {
    await injectTestSession(context, { id: fixtures.admin.id, email: fixtures.admin.email }, baseURL!);
    await setActiveOrg(context, baseURL!, fixtures.orgA.id);
    await page.goto("/notifications");

    const list = page.getByRole("list");
    await expect(list.getByText("Jane Doe changed your role")).toBeVisible();
    await expect(list.getByText("Notification received")).toBeVisible();
  } finally {
    await dbQuery("notification", "deleteMany", { where: { id: { in: [good.id, malformed.id] } } });
  }
});
