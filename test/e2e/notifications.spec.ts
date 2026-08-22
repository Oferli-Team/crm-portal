import { test, expect, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { seedE2EFixtures, cleanupTestData, dbQuery, type TestFixtures } from "./fixtures";
import { injectTestSession } from "../support/e2e-session";

/**
 * getOrCreateOrganizationId only auto-resolves via an existing OWNER
 * membership (see src/lib/current-user.ts) — for any non-OWNER identity
 * (member/admin here) with no active_organization_id cookie yet, that
 * fallback would silently auto-provision a brand-new personal org instead
 * of landing in orgA, which would both point these tests at the wrong org
 * AND leave an orphan Organization/Membership behind. Setting the cookie
 * explicitly is what org-isolation.spec.ts's own fixtures.owner case gets
 * "for free" (owner already owns orgA); every other role needs it spelled out.
 */
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

// G. Notifications — bell/badge/dropdown. The formatter's per-type text
// (all 6 NotificationTypes, actor fallback, malformed metadata) is already
// exhaustively unit-tested in test/unit/format-notification.test.ts, and the
// fan-out/read-model scoping is already exhaustively integration-tested in
// test/integration/notifications/ — this file only covers what those two
// layers can't: the actual bell/badge/dropdown rendering in a real browser.

const BELL = 'summary[aria-label^="Notifications"]';

/** The dropdown panel is the bell's sibling inside the same <details> — scoping
 * to it avoids ambiguity with identical-looking text elsewhere on the page
 * (e.g. /team's own member list). */
function dropdownFor(page: import("@playwright/test").Page) {
  return page.locator("details").filter({ has: page.locator(BELL) });
}

let fixtures: TestFixtures;

test.beforeAll(async () => {
  fixtures = await seedE2EFixtures();
});

test.afterAll(async () => {
  await cleanupTestData(fixtures);
});

test("the bell is visible for a staff session, with no badge when there are no notifications", async ({
  context,
  baseURL,
  page,
}) => {
  await injectTestSession(context, { id: fixtures.owner.id, email: fixtures.owner.email }, baseURL!);
  await page.goto("/dashboard");

  const bell = page.locator(BELL);
  await expect(bell).toBeVisible();
  await expect(bell).toHaveAttribute("aria-label", "Notifications");
});

test("the client portal never renders the staff notification bell", async ({ context, baseURL, page }) => {
  await injectTestSession(context, { id: fixtures.portalUser.id, email: fixtures.portalUser.email }, baseURL!);
  await page.goto("/portal");
  await expect(page.locator(BELL)).toHaveCount(0);
});

test("a real role change produces a Notification, visible with the correct text in the recipient's dropdown", async ({
  context,
  baseURL,
  page,
}) => {
  // Act as the OWNER and change `member`'s role through the real UI —
  // exercises the full stack: mutation -> Activity -> fan-out -> Notification.
  await injectTestSession(context, { id: fixtures.owner.id, email: fixtures.owner.email }, baseURL!);
  await page.goto("/team");
  const memberRow = page.getByRole("row", { name: new RegExp(fixtures.member.email) });
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST"),
    memberRow.getByLabel("Role").selectOption("ADMIN"),
  ]);

  try {
    // Switch to the recipient's own session.
    await context.clearCookies();
    await injectTestSession(context, { id: fixtures.member.id, email: fixtures.member.email }, baseURL!);
    await setActiveOrg(context, baseURL!, fixtures.orgA.id);
    await page.goto("/dashboard");

    const bell = page.locator(BELL);
    await expect(bell).toHaveAttribute("aria-label", /1 unread/);

    await bell.click();
    const dropdown = dropdownFor(page);
    await expect(dropdown.getByText(`${fixtures.owner.name} changed your role`)).toBeVisible();
    await expect(dropdown.getByText("Member → Admin")).toBeVisible();
  } finally {
    await dbQuery("notification", "deleteMany", { where: { organizationId: fixtures.orgA.id } });
    await dbQuery("activity", "deleteMany", {
      where: { organizationId: fixtures.orgA.id, action: "ROLE_CHANGED" },
    });
    await dbQuery("membership", "updateMany", {
      where: { userId: fixtures.member.id, organizationId: fixtures.orgA.id },
      data: { role: "MEMBER" },
    });
  }
});

test("marking one notification read navigates and clears its unread state", async ({ context, baseURL, page }) => {
  const notification = await dbQuery<{ id: string }>("notification", "create", {
    data: {
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.admin.id,
      type: "ROLE_CHANGED",
      metadata: { actorName: "Jane Doe", from: "MEMBER", to: "ADMIN" },
    },
  });

  try {
    await injectTestSession(context, { id: fixtures.admin.id, email: fixtures.admin.email }, baseURL!);
    await setActiveOrg(context, baseURL!, fixtures.orgA.id);
    await page.goto("/dashboard");

    const bell = page.locator(BELL);
    await expect(bell).toHaveAttribute("aria-label", /1 unread/);
    await bell.click();

    // The item's Link navigation and its markNotificationReadAction POST
    // are two independent requests fired from the same click — wait for
    // the action's own response before trusting anything client-side, then
    // reload so /team's layout re-fetches with the by-then-committed state
    // rather than racing a client-side transition.
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST"),
      dropdownFor(page).getByText("Jane Doe changed your role").click(),
    ]);
    await expect(page).toHaveURL(/\/team/);

    const updated = await dbQuery<{ readAt: string | null }>("notification", "findUniqueOrThrow", {
      where: { id: notification.id },
    });
    expect(updated.readAt).not.toBeNull();

    await page.reload();
    await expect(page.locator(BELL)).toHaveAttribute("aria-label", "Notifications");
  } finally {
    await dbQuery("notification", "delete", { where: { id: notification.id } });
  }
});

test("marking all as read clears the badge without navigating away", async ({ context, baseURL, page }) => {
  const notifications = await Promise.all(
    [0, 1].map(() =>
      dbQuery<{ id: string }>("notification", "create", {
        data: {
          organizationId: fixtures.orgA.id,
          recipientId: fixtures.admin.id,
          type: "ROLE_CHANGED",
          metadata: { actorName: "Jane Doe", from: "MEMBER", to: "ADMIN" },
        },
      }),
    ),
  );

  try {
    await injectTestSession(context, { id: fixtures.admin.id, email: fixtures.admin.email }, baseURL!);
    await setActiveOrg(context, baseURL!, fixtures.orgA.id);
    await page.goto("/dashboard");

    const bell = page.locator(BELL);
    await expect(bell).toHaveAttribute("aria-label", /2 unread/);
    await bell.click();
    await page.getByRole("button", { name: "Mark all as read" }).click();

    await expect(page).toHaveURL(/\/dashboard/); // no navigation happened
    await expect(bell).toHaveAttribute("aria-label", "Notifications");
  } finally {
    await dbQuery("notification", "deleteMany", { where: { id: { in: notifications.map((n) => n.id) } } });
  }
});

test("malformed Notification metadata renders a safe fallback instead of crashing the dropdown", async ({
  context,
  baseURL,
  page,
}) => {
  const good = await dbQuery<{ id: string }>("notification", "create", {
    data: {
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.admin.id,
      type: "ROLE_CHANGED",
      metadata: { actorName: "Jane Doe", from: "MEMBER", to: "ADMIN" },
    },
  });
  const malformed = await dbQuery<{ id: string }>("notification", "create", {
    data: {
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.admin.id,
      type: "INVOICE_STATUS_CHANGED",
      // No invoiceNumber at all — format-notification.ts's own defensive
      // fallback path, exercised here through the real rendered page.
      metadata: { unexpected: 12345 },
    },
  });

  try {
    await injectTestSession(context, { id: fixtures.admin.id, email: fixtures.admin.email }, baseURL!);
    await setActiveOrg(context, baseURL!, fixtures.orgA.id);
    await page.goto("/dashboard");

    const bell = page.locator(BELL);
    await bell.click();
    const dropdown = dropdownFor(page);
    await expect(dropdown.getByText("Jane Doe changed your role")).toBeVisible();
    await expect(dropdown.getByText("Notification received")).toBeVisible();
  } finally {
    await dbQuery("notification", "deleteMany", { where: { id: { in: [good.id, malformed.id] } } });
  }
});

test("switching organizations changes the visible notification set", async ({ context, baseURL, page }) => {
  const dualOrgUser = await dbQuery<{ id: string; email: string }>("user", "create", {
    data: { id: randomUUID(), email: `e2e-dual-org-${fixtures.runId}@e2e.test.local`, name: "Dual Org E2E" },
  });
  await dbQuery("membership", "createMany", {
    data: [
      { userId: dualOrgUser.id, organizationId: fixtures.orgA.id, role: "MEMBER" },
      { userId: dualOrgUser.id, organizationId: fixtures.orgB.id, role: "MEMBER" },
    ],
  });
  const notifInA = await dbQuery<{ id: string }>("notification", "create", {
    data: {
      organizationId: fixtures.orgA.id,
      recipientId: dualOrgUser.id,
      type: "ROLE_CHANGED",
      metadata: { actorName: "Org A Actor", from: "MEMBER", to: "ADMIN" },
    },
  });
  const notifInB = await dbQuery<{ id: string }>("notification", "create", {
    data: {
      organizationId: fixtures.orgB.id,
      recipientId: dualOrgUser.id,
      type: "MEMBER_REMOVED",
      metadata: { actorName: "Org B Actor", memberName: "Someone Else" },
    },
  });

  try {
    await injectTestSession(context, { id: dualOrgUser.id, email: dualOrgUser.email }, baseURL!);
    await setActiveOrg(context, baseURL!, fixtures.orgA.id); // land in Org A deterministically first
    await page.goto("/dashboard");

    const bell = page.locator(BELL);
    await expect(bell).toHaveAttribute("aria-label", /1 unread/);
    await bell.click();
    let dropdown = dropdownFor(page);
    await expect(dropdown.getByText("Org A Actor changed your role")).toBeVisible();
    await expect(dropdown.getByText("Org B Actor removed you from the organization")).toHaveCount(0);
    // The dashboard layout (and this <details>'s open DOM state with it)
    // persists across the same-route redirect below — close it explicitly
    // first so the later bell.click() reliably opens rather than toggles it.
    await bell.click();

    // Switch to Org B via the real switcher UI (a <summary>, same reasoning
    // as BELL above — matched structurally, not by an unreliable ARIA role).
    await page.locator("summary", { hasText: "Test Org A" }).click();
    await Promise.all([
      page.waitForURL(/\/dashboard/),
      page.getByRole("button", { name: /Test Org B/ }).click(),
    ]);

    await expect(bell).toHaveAttribute("aria-label", /1 unread/);
    await bell.click();
    dropdown = dropdownFor(page);
    await expect(dropdown.getByText("Org B Actor removed you from the organization")).toBeVisible();
    await expect(dropdown.getByText("Org A Actor changed your role")).toHaveCount(0);
  } finally {
    await dbQuery("notification", "deleteMany", { where: { id: { in: [notifInA.id, notifInB.id] } } });
    await dbQuery("membership", "deleteMany", { where: { userId: dualOrgUser.id } });
    await dbQuery("user", "delete", { where: { id: dualOrgUser.id } });
  }
});

// Stage 6/7 — email delivery. NotificationDelivery status is never
// rendered anywhere in the UI (no page/component reads it), so there's
// nothing to click through beyond what's already covered above; this one
// test only confirms the post-commit wiring fires from a real UI action
// without disturbing the in-app notification UI that Stage 4/5's own tests
// already exercise. No real email is ever sent here: RESEND_API_KEY is
// unset, and playwright.config.ts's INVITATION_FROM_EMAIL is only a
// placeholder — the actual "send" is intercepted by sendEmailViaResend's
// TEST_MODE branch (src/lib/email/resend-client.ts), which fakes success
// without a network call. See test/e2e/notification-preferences.spec.ts
// for the SKIPPED-vs-SENT distinction driven by the user's own preference.
test("a real role change also creates a (test-mode) SENT NotificationDelivery row, and the in-app bell/dropdown are unaffected", async ({
  context,
  baseURL,
  page,
}) => {
  await injectTestSession(context, { id: fixtures.owner.id, email: fixtures.owner.email }, baseURL!);
  await page.goto("/team");
  const memberRow = page.getByRole("row", { name: new RegExp(fixtures.member.email) });
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST"),
    memberRow.getByLabel("Role").selectOption("ADMIN"),
  ]);

  try {
    const activity = await dbQuery<{ id: string }>("activity", "findFirstOrThrow", {
      where: { organizationId: fixtures.orgA.id, action: "ROLE_CHANGED" },
    });
    const notification = await dbQuery<{ id: string }>("notification", "findFirstOrThrow", {
      where: { activityId: activity.id },
    });
    const delivery = await dbQuery<{ status: string; deliveredAt: string | null } | null>(
      "notificationDelivery",
      "findUnique",
      { where: { notificationId_channel: { notificationId: notification.id, channel: "EMAIL" } } },
    );
    expect(delivery?.status).toBe("SENT");
    expect(delivery?.deliveredAt).not.toBeNull();

    // The in-app UI is entirely unaffected — the recipient still sees a
    // normal, correctly-worded unread notification.
    await context.clearCookies();
    await injectTestSession(context, { id: fixtures.member.id, email: fixtures.member.email }, baseURL!);
    await setActiveOrg(context, baseURL!, fixtures.orgA.id);
    await page.goto("/dashboard");
    const bell = page.locator(BELL);
    await expect(bell).toHaveAttribute("aria-label", /1 unread/);
    await bell.click();
    await expect(dropdownFor(page).getByText(`${fixtures.owner.name} changed your role`)).toBeVisible();
  } finally {
    await dbQuery("notification", "deleteMany", { where: { organizationId: fixtures.orgA.id } });
    await dbQuery("activity", "deleteMany", {
      where: { organizationId: fixtures.orgA.id, action: "ROLE_CHANGED" },
    });
    await dbQuery("membership", "updateMany", {
      where: { userId: fixtures.member.id, organizationId: fixtures.orgA.id },
      data: { role: "MEMBER" },
    });
  }
});
