import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext } from "@playwright/test";
import { seedE2EFixtures, cleanupTestData, dbQuery, type TestFixtures } from "./fixtures";
import { injectTestSession } from "../support/e2e-session";

/**
 * Analytics Stage 2 (docs/analytics-architecture.md). Real app/database,
 * no external analytics provider anywhere in this file (there is nothing
 * to call).
 */

let fixtures: TestFixtures;

test.beforeAll(async () => {
  fixtures = await seedE2EFixtures();
});

test.afterAll(async () => {
  await cleanupTestData(fixtures);
});

/** Same pattern as test/e2e/billing-ui.spec.ts's own actAsMember — every identity switch must set active_organization_id explicitly, or a non-OWNER identity gets auto-provisioned a brand-new workspace instead of landing in fixtures.orgA. */
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

test.describe("OWNER", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
  });

  test("Analytics link is visible in the sidebar and navigates to the Analytics page", async ({ page }) => {
    await page.goto("/dashboard");
    const nav = page.getByRole("navigation", { name: "Primary" });
    await nav.getByRole("link", { name: "Analytics" }).click();
    await expect(page).toHaveURL(/\/analytics/);
    await expect(page.getByRole("heading", { name: "Analytics", level: 1 })).toBeVisible();
  });

  test("shows every KPI section with real, non-empty data", async ({ page }) => {
    await page.goto("/analytics");

    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Completion" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Growth" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Status" })).toBeVisible();

    // orgA's seeded fixtures include a real Client/Project/Task/Invoice —
    // the Overview grid must render, not the empty state.
    await expect(page.getByText("No activity yet")).toHaveCount(0);
  });

  test("Stage 3: shows every chart section, and each chart actually renders (real SVG, not an empty container)", async ({ page }) => {
    await page.goto("/analytics");

    await expect(page.getByRole("heading", { name: "Trends", exact: true })).toBeVisible();
    for (const heading of ["Task & invoice activity", "Period comparison", "Organization activity"]) {
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    }

    // Recharts renders a real <svg> per chart — this proves the chart
    // library actually mounted and drew something, not just that the
    // section heading text is present.
    const trendsSection = page.locator("section", { has: page.getByRole("heading", { name: "Trends", exact: true }) });
    await expect(trendsSection.locator("svg").first()).toBeVisible();

    const activitySection = page.locator("section", { has: page.getByRole("heading", { name: "Task & invoice activity" }) });
    await expect(activitySection.locator("svg").first()).toBeVisible();

    const orgActivitySection = page.locator("section", { has: page.getByRole("heading", { name: "Organization activity" }) });
    await expect(orgActivitySection.getByRole("progressbar", { name: "Onboarding progress" })).toBeVisible();
    await expect(orgActivitySection.getByText("Subscription events")).toBeVisible();
  });

  test("Stage 3: charts have an accessible name via role=img + aria-label, never relying on color alone", async ({ page }) => {
    await page.goto("/analytics");
    const clientChart = page.getByRole("img", { name: /Clients over time/i });
    await expect(clientChart).toBeVisible();
    const taskChart = page.getByRole("img", { name: /Tasks: \d+ created, \d+ completed/i });
    await expect(taskChart).toBeVisible();
  });

  test("Stage 4: shows the Portal section with real KPI cards and a chart, reusing Stage 2/3 components", async ({ page }) => {
    await page.goto("/analytics");

    const portalSection = page.locator("section", { has: page.getByRole("heading", { name: "Portal", exact: true }) });
    await expect(portalSection).toBeVisible();
    await expect(portalSection.getByText("Portal users", { exact: true })).toBeVisible();
    await expect(portalSection.getByText("Portal adoption", { exact: true })).toBeVisible();
    await expect(portalSection.getByText("Documents available", { exact: true })).toBeVisible();
    await expect(portalSection.getByText("Invoices visible", { exact: true })).toBeVisible();

    // orgA's fixtures seed one PortalUser + one attachment reachable by
    // it — the section must render real KPI cards, not the empty state.
    await expect(portalSection.getByText("No activity yet")).toHaveCount(0);
    await expect(portalSection.locator("svg").first()).toBeVisible();
  });

  test("Stage 4: the Portal section never exposes a portal contact's email, name, or internal id as visible text", async ({ page }) => {
    await page.goto("/analytics");
    const portalSection = page.locator("section", { has: page.getByRole("heading", { name: "Portal", exact: true }) });
    const sectionText = await portalSection.innerText();
    expect(sectionText).not.toContain(fixtures.portalUser.email);
    expect(sectionText).not.toContain(fixtures.portalUser.name);
    expect(sectionText).not.toContain(fixtures.portalUser.id);
    expect(sectionText).not.toContain(fixtures.clientA.id);
  });

  test("Stage 4: a brand-new organization with no portal users shows the Portal empty state, not a broken grid", async ({ page, context, baseURL }) => {
    const empty = await dbQuery<{ id: string }>("organization", "create", { data: { name: `E2E Analytics Portal Empty ${fixtures.runId}`, slug: `e2e-analytics-portal-empty-${fixtures.runId}` } });
    await dbQuery("membership", "create", { data: { userId: fixtures.owner.id, organizationId: empty.id, role: "OWNER" } });

    try {
      await actAsMember(context, baseURL!, fixtures.owner, empty.id);
      await page.goto("/analytics");
      const portalSection = page.locator("section", { has: page.getByRole("heading", { name: "Portal", exact: true }) });
      await expect(portalSection.getByText("No activity yet")).toBeVisible();
    } finally {
      await dbQuery("membership", "deleteMany", { where: { organizationId: empty.id } });
      await dbQuery("organization", "delete", { where: { id: empty.id } });
    }
  });

  test.describe("Portal Analytics persistence Slice 2: recentlyActivePortalUsers / documentDownloadRequests", () => {
    /**
     * Locates the exact AnalyticsCard for `label` and asserts its own
     * value — never a page-wide text search — so a matching number
     * rendered by an unrelated card cannot make this pass accidentally.
     * AnalyticsCard's own markup (analytics-card.tsx) always renders the
     * label as the immediate previous sibling's text; the card root is
     * that text node's own parent element.
     */
    function cardValue(scope: import("@playwright/test").Locator, label: string) {
      return scope.getByText(label, { exact: true }).locator("xpath=..");
    }

    /**
     * GrowthIndicator (growth-indicator.tsx) is a text-only `<span>` with
     * no `role="img"` and no `<svg>` — checking only those two proves
     * "no chart," not "no growth indicator." It renders exactly one of
     * two `aria-label` shapes (`"${label}: ${direction} ${magnitude}%
     * compared with the previous period"` or `"${label}: no
     * prior-period data"`), so asserting neither substring is present
     * inside the card is the real proof of absence.
     */
    function expectNoGrowthIndicator(card: import("@playwright/test").Locator) {
      return Promise.all([
        expect(card.locator('[aria-label*="compared with the previous period"]')).toHaveCount(0),
        expect(card.locator('[aria-label*="no prior-period data"]')).toHaveCount(0),
      ]);
    }

    test("real scalar values render inside their own cards, with no growth indicator/comparison/chart, and no PII", async ({ page, context, baseURL }) => {
      const tempPortalUserIds = [randomUUID(), randomUUID()];
      const originalPortalUserLastLoginAt = (
        await dbQuery<{ lastLoginAt: string | null }>("portalUser", "findUniqueOrThrow", {
          where: { id: fixtures.portalUser.id },
          select: { lastLoginAt: true },
        })
      ).lastLoginAt;
      const downloadRows = await dbQuery<{ id: string }[]>("portalDownloadRequest", "createManyAndReturn", {
        data: [
          { organizationId: fixtures.orgA.id, requestedAt: new Date() },
          { organizationId: fixtures.orgA.id, requestedAt: new Date() },
          { organizationId: fixtures.orgA.id, requestedAt: new Date() },
        ],
      });

      try {
        await dbQuery("portalUser", "createMany", {
          data: tempPortalUserIds.map((id, i) => ({
            id,
            clientId: fixtures.clientA.id,
            email: `e2e-engagement-${i}-${fixtures.runId}@e2e-test.example`,
            name: `E2E Engagement User ${i}`,
            lastLoginAt: new Date(),
          })),
        });
        // fixtures.portalUser itself must stay excluded from this count —
        // explicitly confirmed unset, defensively, regardless of any
        // other test's own ordering. Restored in `finally` below.
        await dbQuery("portalUser", "update", { where: { id: fixtures.portalUser.id }, data: { lastLoginAt: null } });

        await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
        await page.goto("/analytics");

        const portalSection = page.locator("section", { has: page.getByRole("heading", { name: "Portal", exact: true }) });
        const overviewGrid = portalSection.locator("section", { has: page.getByRole("heading", { name: "Portal overview" }) });

        const activeUsersCard = cardValue(overviewGrid, "Recently active portal users");
        await expect(activeUsersCard.getByText("2", { exact: true })).toBeVisible();
        await expect(activeUsersCard.locator("svg")).toHaveCount(0);
        await expect(activeUsersCard.getByRole("img")).toHaveCount(0); // no chart
        await expectNoGrowthIndicator(activeUsersCard);

        const downloadsCard = cardValue(overviewGrid, "Download-link requests");
        await expect(downloadsCard.getByText("3", { exact: true })).toBeVisible();
        await expect(downloadsCard.locator("svg")).toHaveCount(0);
        await expect(downloadsCard.getByRole("img")).toHaveCount(0);
        await expectNoGrowthIndicator(downloadsCard);

        const sectionText = await portalSection.innerText();
        for (const id of tempPortalUserIds) expect(sectionText).not.toContain(id);
        for (const row of downloadRows) expect(sectionText).not.toContain(row.id);
        expect(sectionText).not.toContain("e2e-engagement-0");
        expect(sectionText).not.toContain("E2E Engagement User");
        expect(sectionText).not.toContain(fixtures.clientA.id);
      } finally {
        await dbQuery("portalUser", "deleteMany", { where: { id: { in: tempPortalUserIds } } });
        await dbQuery("portalDownloadRequest", "deleteMany", { where: { id: { in: downloadRows.map((r) => r.id) } } });
        await dbQuery("portalUser", "update", {
          where: { id: fixtures.portalUser.id },
          data: { lastLoginAt: originalPortalUserLastLoginAt },
        });
      }
    });

    test("data older than 30 days is excluded from range=last30Days and included under literal range=allTime, for both metrics", async ({
      page,
      context,
      baseURL,
    }) => {
      // Comfortably away from the 30-day boundary (45 days) to avoid
      // wall-clock flakiness — never right at the edge.
      const oldInstant = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
      const tempPortalUserId = randomUUID();
      const originalPortalUserLastLoginAt = (
        await dbQuery<{ lastLoginAt: string | null }>("portalUser", "findUniqueOrThrow", {
          where: { id: fixtures.portalUser.id },
          select: { lastLoginAt: true },
        })
      ).lastLoginAt;

      const downloadRow = await dbQuery<{ id: string }>("portalDownloadRequest", "create", {
        data: { organizationId: fixtures.orgA.id, requestedAt: oldInstant },
      });

      try {
        await dbQuery("portalUser", "create", {
          data: {
            id: tempPortalUserId,
            clientId: fixtures.clientA.id,
            email: `e2e-old-login-${fixtures.runId}@e2e-test.example`,
            name: "E2E Old Login User",
            lastLoginAt: oldInstant,
          },
        });
        // Restored in `finally` below.
        await dbQuery("portalUser", "update", { where: { id: fixtures.portalUser.id }, data: { lastLoginAt: null } });

        await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);

        await page.goto("/analytics?range=last30Days");
        const portalSection30 = page.locator("section", { has: page.getByRole("heading", { name: "Portal", exact: true }) });
        const overviewGrid30 = portalSection30.locator("section", { has: page.getByRole("heading", { name: "Portal overview" }) });
        await expect(cardValue(overviewGrid30, "Recently active portal users").getByText("0", { exact: true })).toBeVisible();
        await expect(cardValue(overviewGrid30, "Download-link requests").getByText("0", { exact: true })).toBeVisible();

        await page.goto("/analytics?range=allTime");
        const portalSectionAll = page.locator("section", { has: page.getByRole("heading", { name: "Portal", exact: true }) });
        const overviewGridAll = portalSectionAll.locator("section", { has: page.getByRole("heading", { name: "Portal overview" }) });
        await expect(cardValue(overviewGridAll, "Recently active portal users").getByText("1", { exact: true })).toBeVisible();
        await expect(cardValue(overviewGridAll, "Download-link requests").getByText("1", { exact: true })).toBeVisible();
      } finally {
        await dbQuery("portalUser", "deleteMany", { where: { id: tempPortalUserId } });
        await dbQuery("portalDownloadRequest", "deleteMany", { where: { id: downloadRow.id } });
        await dbQuery("portalUser", "update", {
          where: { id: fixtures.portalUser.id },
          data: { lastLoginAt: originalPortalUserLastLoginAt },
        });
      }
    });

    test("historical download-link requests keep the Portal section visible even after its Client (and PortalUser) are deleted", async ({
      page,
      context,
      baseURL,
    }) => {
      // Only the Organization is created outside `try` — it has no prior
      // dependency, so if this single call fails there is nothing yet to
      // clean up. Every dependent row (Membership/Client/PortalUser/
      // PortalDownloadRequest) is created inside `try`, so a partial
      // setup failure anywhere after this point still reaches `finally`.
      const org = await dbQuery<{ id: string }>("organization", "create", {
        data: { name: `E2E Historical Download Org ${fixtures.runId}`, slug: `e2e-historical-download-${fixtures.runId}` },
      });

      try {
        await dbQuery("membership", "create", { data: { userId: fixtures.owner.id, organizationId: org.id, role: "OWNER" } });
        const client = await dbQuery<{ id: string }>("client", "create", {
          data: { name: "Temp Historical Client", userId: fixtures.owner.id, organizationId: org.id },
        });
        const portalUserId = randomUUID();
        await dbQuery("portalUser", "create", {
          data: {
            id: portalUserId,
            clientId: client.id,
            email: `e2e-historical-${fixtures.runId}@e2e-test.example`,
            name: "E2E Historical Portal User",
          },
        });
        await dbQuery("portalDownloadRequest", "create", { data: { organizationId: org.id, requestedAt: new Date() } });

        // Deleting the Client cascades away its PortalUser — the
        // organization-scoped PortalDownloadRequest row has no
        // relationship to either, so it survives.
        await dbQuery("client", "delete", { where: { id: client.id } });

        await actAsMember(context, baseURL!, fixtures.owner, org.id);
        await page.goto("/analytics");

        const portalSection = page.locator("section", { has: page.getByRole("heading", { name: "Portal", exact: true }) });
        await expect(portalSection.getByText("No activity yet")).toHaveCount(0);

        const overviewGrid = portalSection.locator("section", { has: page.getByRole("heading", { name: "Portal overview" }) });
        await expect(cardValue(overviewGrid, "Portal users").getByText("0", { exact: true })).toBeVisible();
        await expect(cardValue(overviewGrid, "Download-link requests").getByText("1", { exact: true })).toBeVisible();
      } finally {
        // `deleteMany` (never a not-found-throwing `delete`) scoped by
        // `organizationId`, in dependency order, so this is safe
        // regardless of how far setup got: nothing is left behind even
        // if `client`/`portalUserId` never got created. `client` is
        // deleted explicitly (its own onDelete is `SetNull`, not
        // `Cascade`, on Organization) rather than relied on to vanish
        // when the Organization itself is deleted below.
        await dbQuery("portalDownloadRequest", "deleteMany", { where: { organizationId: org.id } });
        await dbQuery("client", "deleteMany", { where: { organizationId: org.id } });
        await dbQuery("membership", "deleteMany", { where: { organizationId: org.id } });
        await dbQuery("organization", "delete", { where: { id: org.id } });
      }
    });
  });

  test("Status section never exposes a raw internal enum value or a provider/organization id as visible text", async ({ page }) => {
    await page.goto("/analytics");

    // Scoped to visible text content, not the raw document — the RSC
    // hydration payload legitimately embeds this same organization's own
    // id elsewhere on every dashboard page (e.g. for the search widget),
    // which is normal Next.js infrastructure, not something Analytics
    // itself renders. What matters is that no *visible* text anywhere on
    // the page shows a provider id, and that the Status section
    // specifically never shows a raw enum value.
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/mock_cus_|mock_sub_|providerCustomerId|providerSubscriptionId/);
    expect(bodyText).not.toContain(fixtures.orgA.id);

    // formatStatusLabel/getPlan always produce Title Case ("Legacy",
    // "Active", "Trialing") — the raw, all-caps Prisma enum value
    // ("LEGACY", "TRIALING", ...) must never appear as visible text.
    for (const rawEnumValue of ["LEGACY", "TRIALING", "PAST_DUE", "CANCELED", "INCOMPLETE", "UNPAID", "TRIAL", "STARTER", "PRO"]) {
      expect(bodyText).not.toContain(rawEnumValue);
    }
  });

  test("range selector navigates via URL search params, never a cookie, and the selection survives a reload", async ({ page, context }) => {
    await page.goto("/analytics");
    const nav = page.getByRole("navigation", { name: "Time range" });
    await nav.getByRole("link", { name: "Last 7 days" }).click();
    await expect(page).toHaveURL(/\?range=last7Days/);
    await expect(nav.getByRole("link", { name: "Last 7 days" })).toHaveAttribute("aria-current", "true");

    await page.reload();
    await expect(page).toHaveURL(/\?range=last7Days/);
    await expect(nav.getByRole("link", { name: "Last 7 days" })).toHaveAttribute("aria-current", "true");

    const cookies = await context.cookies();
    expect(cookies.some((c) => c.name.toLowerCase().includes("range"))).toBe(false);
  });

  test("an unrecognized range query value falls back to the default range instead of crashing", async ({ page }) => {
    await page.goto("/analytics?range=not-a-real-range");
    await expect(page.getByRole("heading", { name: "Analytics", level: 1 })).toBeVisible();
    await expect(page.getByText(/internal server error/i)).toHaveCount(0);
  });

  test("a brand-new organization with no data shows the empty state, not a broken grid", async ({ page, context, baseURL }) => {
    const empty = await dbQuery<{ id: string }>("organization", "create", { data: { name: `E2E Analytics Empty ${fixtures.runId}`, slug: `e2e-analytics-empty-${fixtures.runId}` } });
    await dbQuery("membership", "create", { data: { userId: fixtures.owner.id, organizationId: empty.id, role: "OWNER" } });

    try {
      await actAsMember(context, baseURL!, fixtures.owner, empty.id);
      await page.goto("/analytics");
      // Both the Overview and Portal sections are empty for a brand-new
      // org — two independent "No activity yet" empty states, one per
      // section, not a bug.
      await expect(page.getByText("No activity yet")).toHaveCount(2);
      // Other sections still render normally alongside the empty Overview.
      await expect(page.getByRole("heading", { name: "Growth" })).toBeVisible();
      await expect(page.getByText("0%").first()).toBeVisible();
    } finally {
      await dbQuery("membership", "deleteMany", { where: { organizationId: empty.id } });
      await dbQuery("organization", "delete", { where: { id: empty.id } });
    }
  });
});

test.describe("ADMIN", () => {
  test("ADMIN also sees the full Analytics page", async ({ page, context, baseURL }) => {
    await actAsMember(context, baseURL!, fixtures.admin, fixtures.orgA.id);
    await page.goto("/analytics");
    await expect(page.getByRole("heading", { name: "Analytics", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  });
});

test.describe("MEMBER", () => {
  test("MEMBER sees an Access denied state, never the real data", async ({ page, context, baseURL }) => {
    await actAsMember(context, baseURL!, fixtures.member, fixtures.orgA.id);
    await page.goto("/analytics");
    await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toHaveCount(0);
  });
});

test.describe("Client Portal", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await injectTestSession(context, { id: fixtures.portalUser.id, email: fixtures.portalUser.email }, baseURL!);
  });

  test("no Analytics link in the portal nav, and the staff analytics route redirects away", async ({ page }) => {
    await page.goto("/portal");
    await expect(page.getByRole("link", { name: "Analytics" })).toHaveCount(0);

    await page.goto("/analytics");
    await expect(page).toHaveURL(/\/portal$/);
  });
});

test.describe("Accessibility", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
  });

  test("every section is a labeled landmark reachable by heading structure", async ({ page }) => {
    await page.goto("/analytics");
    await expect(page.getByRole("heading", { level: 1, name: "Analytics" })).toBeVisible();
    for (const name of ["Completion", "Growth", "Status", "Period comparison"]) {
      await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
    }
    await expect(page.getByRole("heading", { level: 2, name: "Overview", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Activity", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Trends", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Task & invoice activity" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Organization activity" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Portal", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Portal overview" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Portal trends" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Time range" })).toBeVisible();
  });

  test("the range selector is fully keyboard-reachable with a visible focus state", async ({ page }) => {
    await page.goto("/analytics");
    const firstRangeLink = page.getByRole("navigation", { name: "Time range" }).getByRole("link").first();
    await firstRangeLink.focus();
    await expect(firstRangeLink).toBeFocused();
  });
});

test.describe("Mobile", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("Analytics page renders usably on a small viewport, with no horizontal overflow", async ({ page, context, baseURL }) => {
    await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
    await page.goto("/analytics");
    await expect(page.getByRole("heading", { name: "Analytics", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();

    const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(hasHorizontalOverflow).toBe(false);
  });
});

test.describe("Tablet", () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test("Analytics page renders usably on a tablet viewport, with no horizontal overflow", async ({ page, context, baseURL }) => {
    await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
    await page.goto("/analytics");
    await expect(page.getByRole("heading", { name: "Analytics", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();

    const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(hasHorizontalOverflow).toBe(false);
  });
});

test.describe("Desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Analytics page renders usably on a desktop viewport, with no horizontal overflow", async ({ page, context, baseURL }) => {
    await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
    await page.goto("/analytics");
    await expect(page.getByRole("heading", { name: "Analytics", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();

    const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(hasHorizontalOverflow).toBe(false);
  });
});

// Regression safety net (added after main received PR #19's mobile header
// fix and PR #21's tablet-breakpoint overflow fix — both shared-layout
// changes, neither one touching Analytics code). Proves Analytics keeps
// rendering correctly at every breakpoint those fixes targeted, and closes
// a few pre-existing coverage gaps the earlier Stage 2-5 suite above
// didn't need: the full breakpoint set (only 375/768/1280 were covered),
// every supported range (only last7Days was exercised end to end), a
// correct "no empty chart container" check (deliberately not `[class*=
// "chart"]`, which false-positives on every recharts-* internal SVG
// sub-node), and cross-org leakage specifically on this page. No
// Analytics application code changes alongside this file.
test.describe("Regression: Analytics health after unrelated layout changes (PR #19 / PR #21)", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
  });

  // 320/390/430 close the PR #19 mobile-breakpoint gap; 834/1024 close the
  // PR #21 tablet-breakpoint gap. 375/768/1280 stay covered by the
  // existing Mobile/Tablet/Desktop describes above, not duplicated here.
  for (const width of [320, 390, 430, 834, 1024]) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/analytics");
      await expect(page.getByRole("heading", { name: "Analytics", level: 1 })).toBeVisible();
      const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(hasHorizontalOverflow).toBe(false);
    });
  }

  test("every supported time range updates the URL, and the selection survives a reload", async ({ page }) => {
    const nav = page.getByRole("navigation", { name: "Time range" });
    for (const [label, param] of [
      ["Today", "today"],
      ["Last 7 days", "last7Days"],
      ["Last 30 days", "last30Days"],
      ["Last 90 days", "last90Days"],
      ["All time", "allTime"],
    ] as const) {
      await page.goto("/analytics");
      await nav.getByRole("link", { name: label }).click();
      await expect(page).toHaveURL(new RegExp(`\\?range=${param}$`));
      await expect(nav.getByRole("link", { name: label })).toHaveAttribute("aria-current", "true");

      await page.reload();
      await expect(page).toHaveURL(new RegExp(`\\?range=${param}$`));
      await expect(nav.getByRole("link", { name: label })).toHaveAttribute("aria-current", "true");
    }
  });

  test("every chart renders real content (no empty container) and exposes a non-empty accessible name", async ({ page }) => {
    await page.goto("/analytics?range=allTime");

    // A real Recharts mount always produces at least one populated
    // .recharts-wrapper (containing a drawn <svg>, never an empty shell) —
    // this is the correct signal Stage 3's own test above already uses
    // per-section; here it's asserted globally, once, across every chart
    // on the page.
    const wrappers = page.locator(".recharts-wrapper");
    // .count() (unlike expect(locator).toBeVisible()) does not auto-wait —
    // Recharts is a Client Component, so the first wrapper only exists
    // after hydration mounts it. Wait for that before counting, or this
    // races the count against hydration and reads 0.
    await expect(wrappers.first()).toBeVisible();
    const wrapperCount = await wrappers.count();
    expect(wrapperCount).toBeGreaterThan(0);
    for (let i = 0; i < wrapperCount; i++) {
      // .first(): a wrapper with a chart legend renders more than one
      // <svg> (the legend's own small icon swatches alongside the main
      // chart) — any one of them being visible already proves this
      // wrapper isn't an empty shell.
      await expect(wrappers.nth(i).locator("svg").first()).toBeVisible();
    }

    // Every chart's accessible name (role=img + aria-label, Recharts'
    // accessibilityLayer) must be present and non-empty — never relying on
    // color/shape alone, and never a blank string that would announce as
    // nothing to a screen reader.
    const chartImages = page.getByRole("img");
    await expect(chartImages.first()).toBeVisible();
    const chartImageCount = await chartImages.count();
    expect(chartImageCount).toBeGreaterThan(0);
    for (let i = 0; i < chartImageCount; i++) {
      const ariaLabel = await chartImages.nth(i).getAttribute("aria-label");
      expect(ariaLabel, `chart image ${i} should have a non-empty aria-label`).toBeTruthy();
      expect(ariaLabel!.trim().length).toBeGreaterThan(0);
    }
  });

  test("Billing/Onboarding integration: the Status section shows a real plan name, subscription status badge, and onboarding percent", async ({ page }) => {
    await page.goto("/analytics");
    const statusSection = page.locator("section", { has: page.getByRole("heading", { name: "Status", exact: true }) });
    await expect(statusSection).toBeVisible();
    // fixtures.orgA has no seeded Subscription row — access-mode.ts's own
    // documented "missing row = LEGACY, full access" fallback — so this
    // also proves that fallback still renders a real plan name, not a
    // crash or a blank value.
    await expect(statusSection.getByText("Legacy (pre-billing)")).toBeVisible();
    await expect(statusSection.getByText(/^\d+%$/)).toBeVisible();
  });

  test("no cross-organization leakage: Org B's client/org data never appears on Org A's Analytics page", async ({ page }) => {
    await page.goto("/analytics?range=allTime");
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain(fixtures.clientB.name);
    expect(bodyText).not.toContain(fixtures.orgB.slug);
    expect(bodyText).not.toContain(fixtures.orgB.id);
  });
});
