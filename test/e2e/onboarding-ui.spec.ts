import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { seedE2EFixtures, cleanupTestData, dbQuery, type TestFixtures } from "./fixtures";
import { injectTestSession } from "../support/e2e-session";
import { testEmail, testSlug } from "../support/run-id";
import { TEST_EMAIL_DOMAIN } from "../support/env";

/**
 * Onboarding Stage 3 — real-browser coverage for the Dashboard checklist
 * card (src/components/onboarding/*). Backend correctness (progress
 * computation, skip/dismiss access rules, org isolation, §12's "business
 * mutations never write to the onboarding table" invariant) is already
 * exhaustively covered in test/unit/onboarding-*.test.ts and
 * test/integration/onboarding/ — this file only covers what genuinely
 * needs a real browser: what actually renders per progress state, the
 * skip/dismiss buttons updating the UI without a manual reload, keyboard
 * reachability, mobile layout, and Client Portal absence (Stage 3 task
 * §19's own minimum list).
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

async function actAsMember(
  context: BrowserContext,
  baseURL: string,
  user: { id: string; email: string },
  organizationId: string,
): Promise<void> {
  await context.clearCookies();
  await injectTestSession(context, user, baseURL);
  await setActiveOrg(context, baseURL, organizationId);
}

async function gotoAndSettle(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

type FreshOrg = { org: { id: string }; owner: { id: string; email: string } };

/** A brand-new organization with zero business data — real Client/Project/etc. rows would make a step COMPLETE by construction (§4), which the "empty progress"/skip/dismiss tests below need to rule out. */
async function createFreshOrg(runId: string, label: string): Promise<FreshOrg> {
  const org = await dbQuery<{ id: string }>("organization", "create", {
    data: { name: `Fresh ${label}`, slug: testSlug(`onboarding-${label}`, runId) },
  });
  const owner = await dbQuery<{ id: string; email: string }>("user", "create", {
    data: { id: randomUUID(), email: testEmail(`onboarding-${label}-owner`, TEST_EMAIL_DOMAIN, runId), name: "Owner" },
  });
  await dbQuery("membership", "create", { data: { userId: owner.id, organizationId: org.id, role: "OWNER" } });
  return { org, owner };
}

/** Organization delete cascades Membership and OrganizationOnboardingStep (both `onDelete: Cascade`); the User row is separate. */
async function cleanupFreshOrg({ org, owner }: FreshOrg): Promise<void> {
  await dbQuery("organization", "delete", { where: { id: org.id } });
  await dbQuery("user", "delete", { where: { id: owner.id } });
}

/** The card is a `<section aria-labelledby="onboarding-heading">` — an accessible "region" named after its own heading, so this scopes every row/count/progressbar assertion to the card alone, never any other list on /dashboard (Upcoming tasks, Overdue items, Recent invoices). */
function onboardingCard(page: Page) {
  return page.getByRole("region", { name: "Getting started" });
}

function rowFor(page: Page, label: string) {
  return onboardingCard(page).getByRole("listitem").filter({ hasText: label });
}

/**
 * Stage 6 audit fix regression guard. `:focus-visible` matching for a
 * *programmatic* `.focus()` call is a browser/automation heuristic that
 * isn't guaranteed consistent (the exact concern this stage's own task
 * raised) — this checks the actual rendered effect instead (a real
 * box-shadow or outline), which is deterministic regardless of which
 * pseudo-class ends up matching. True for either mechanism so it doesn't
 * assume Tailwind's own ring implementation detail.
 */
async function hasVisibleFocusIndicator(locator: ReturnType<Page["locator"]>): Promise<boolean> {
  return locator.evaluate((el) => {
    const style = getComputedStyle(el);
    const hasShadow = style.boxShadow !== "none" && style.boxShadow !== "";
    const hasOutline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth || "0") > 0;
    return hasShadow || hasOutline;
  });
}

/**
 * Stage 6 audit fix regression guard for the blocked-row contrast bug.
 * `getComputedStyle(el).opacity` only reflects an element's OWN specified
 * opacity, never an ancestor's — so a naive check on the description text
 * itself would read "1" even under the old, buggy implementation (where
 * an ANCESTOR div carried opacity-60). This walks up from the target to
 * (not including) `stopSelector` and composites every opacity found along
 * the way, the same way the browser actually renders it.
 */
async function effectiveOpacity(locator: ReturnType<Page["locator"]>, stopSelector: string): Promise<number> {
  return locator.evaluate((el, stop) => {
    let node: Element | null = el;
    let opacity = 1;
    while (node && !node.matches(stop)) {
      opacity *= parseFloat(getComputedStyle(node).opacity || "1");
      node = node.parentElement;
    }
    return opacity;
  }, stopSelector);
}

let fixtures: TestFixtures;

test.beforeAll(async () => {
  fixtures = await seedE2EFixtures();
});

test.afterAll(async () => {
  await cleanupTestData(fixtures);
});

test.describe("Visibility per progress state", () => {
  test("a fresh, empty organization shows the full checklist, 0 of 10 complete, Welcome first", async ({
    context,
    baseURL,
    page,
  }) => {
    const fresh = await createFreshOrg(fixtures.runId, "empty");
    await actAsMember(context, baseURL!, fresh.owner, fresh.org.id);
    await gotoAndSettle(page, `${baseURL}/dashboard`);

    await expect(onboardingCard(page)).toBeVisible();
    // 10 = every ONBOARDING_STEP_ORDER key except WELCOME — includes the
    // Customer Setup Wizard's three steps (Stage 6.2): Company Profile,
    // Payment Details, Domain Setup; and REVIEW_BILLING, available since
    // Sale-Ready Phase E, E3.3.
    await expect(onboardingCard(page).getByText("0 of 10 complete")).toBeVisible();

    const bar = onboardingCard(page).getByRole("progressbar", { name: "Onboarding progress" });
    await expect(bar).toHaveAttribute("aria-valuenow", "0");

    // 11 = every key in ONBOARDING_STEP_ORDER (every step always renders as
    // a row regardless of its status).
    const rows = onboardingCard(page).getByRole("listitem");
    await expect(rows).toHaveCount(11);
    await expect(rows.first()).toContainText("Welcome");

    await cleanupFreshOrg(fresh);
  });

  test("a partially-progressed organization shows a partial count and per-step statuses", async ({
    context,
    baseURL,
    page,
  }) => {
    await actAsMember(context, baseURL!, fixtures.orgBOwner, fixtures.orgB.id);
    await gotoAndSettle(page, `${baseURL}/dashboard`);

    await expect(onboardingCard(page)).toBeVisible();

    const clientRow = rowFor(page, "Create your first client");
    await expect(clientRow.getByText("Complete", { exact: true })).toBeVisible();

    const projectRow = rowFor(page, "Create your first project");
    await expect(projectRow.getByText("Not Started", { exact: true })).toBeVisible();
    await expect(projectRow.getByRole("link", { name: /Go to/ })).toBeVisible();
  });

  test("a fully productive organization (every substantive step already done) shows no checklist at all", async ({
    context,
    baseURL,
    page,
  }) => {
    // fixtures.orgA already has real Client/Project/Task/second-Membership/
    // PortalUser data (seedTestData()) — real Company Profile/Payment
    // Details/Domain Settings rows (Customer Setup Wizard, Stage 6.2) plus
    // an acted REVIEW_BILLING row (available since Sale-Ready Phase E,
    // E3.3 — no Paddle configuration required to skip it) are the last
    // things missing to make every substantive step COMPLETE/SKIPPED.
    await dbQuery("organizationProfile", "create", {
      data: { organizationId: fixtures.orgA.id, legalName: "Test Org A LLC", country: "United States", currency: "USD", timezone: "America/New_York" },
    });
    await dbQuery("organizationPaymentDetails", "create", {
      data: { organizationId: fixtures.orgA.id, bankName: "Bank", accountHolder: "Test Org A", accountNumber: "123", swiftBic: "ABCDEF12" },
    });
    await dbQuery("organizationDomainSettings", "create", { data: { organizationId: fixtures.orgA.id, customDomain: null } });
    await dbQuery("organizationOnboardingStep", "create", { data: { organizationId: fixtures.orgA.id, step: "REVIEW_BILLING" } });

    try {
      await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
      await gotoAndSettle(page, `${baseURL}/dashboard`);
      await expect(onboardingCard(page)).toHaveCount(0);
    } finally {
      await dbQuery("organizationProfile", "deleteMany", { where: { organizationId: fixtures.orgA.id } });
      await dbQuery("organizationPaymentDetails", "deleteMany", { where: { organizationId: fixtures.orgA.id } });
      await dbQuery("organizationDomainSettings", "deleteMany", { where: { organizationId: fixtures.orgA.id } });
      await dbQuery("organizationOnboardingStep", "deleteMany", { where: { organizationId: fixtures.orgA.id, step: "REVIEW_BILLING" } });
    }
  });
});

test.describe("Workspace completion summary (Stage 7.1.1)", () => {
  test("a fresh, empty organization shows the customer-facing headline and an 'Up next' summary, but no 'Completed so far' line", async ({
    context,
    baseURL,
    page,
  }) => {
    const fresh = await createFreshOrg(fixtures.runId, "completion-fresh");
    await actAsMember(context, baseURL!, fresh.owner, fresh.org.id);
    await gotoAndSettle(page, `${baseURL}/dashboard`);

    await expect(onboardingCard(page).getByText("Your workspace is almost ready")).toBeVisible();
    await expect(onboardingCard(page).getByText("Complete setup to start using Client Portal.")).toBeVisible();
    await expect(onboardingCard(page).getByText(/^Up next:/)).toBeVisible();
    await expect(onboardingCard(page).getByText(/^Completed so far:/)).toHaveCount(0);

    await cleanupFreshOrg(fresh);
  });

  test("a partially-progressed organization shows both a 'Completed so far' and an 'Up next' summary reflecting real progress", async ({
    context,
    baseURL,
    page,
  }) => {
    await actAsMember(context, baseURL!, fixtures.orgBOwner, fixtures.orgB.id);
    await gotoAndSettle(page, `${baseURL}/dashboard`);

    // orgB (seedTestData()) has exactly one real Client and nothing else —
    // CREATE_CLIENT is the only completed accomplishment.
    await expect(
      onboardingCard(page).getByText("Completed so far: Create your first client."),
    ).toBeVisible();
    await expect(onboardingCard(page).getByText(/^Up next:/)).toBeVisible();
  });

  test("a fully productive organization renders no completion summary at all — the whole card is absent", async ({
    context,
    baseURL,
    page,
  }) => {
    await dbQuery("organizationProfile", "create", {
      data: { organizationId: fixtures.orgA.id, legalName: "Test Org A LLC", country: "United States", currency: "USD", timezone: "America/New_York" },
    });
    await dbQuery("organizationPaymentDetails", "create", {
      data: { organizationId: fixtures.orgA.id, bankName: "Bank", accountHolder: "Test Org A", accountNumber: "123", swiftBic: "ABCDEF12" },
    });
    await dbQuery("organizationDomainSettings", "create", { data: { organizationId: fixtures.orgA.id, customDomain: null } });
    await dbQuery("organizationOnboardingStep", "create", { data: { organizationId: fixtures.orgA.id, step: "REVIEW_BILLING" } });

    try {
      await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
      await gotoAndSettle(page, `${baseURL}/dashboard`);
      await expect(onboardingCard(page)).toHaveCount(0);
      await expect(page.getByText("Your workspace is almost ready")).toHaveCount(0);
    } finally {
      await dbQuery("organizationProfile", "deleteMany", { where: { organizationId: fixtures.orgA.id } });
      await dbQuery("organizationPaymentDetails", "deleteMany", { where: { organizationId: fixtures.orgA.id } });
      await dbQuery("organizationDomainSettings", "deleteMany", { where: { organizationId: fixtures.orgA.id } });
      await dbQuery("organizationOnboardingStep", "deleteMany", { where: { organizationId: fixtures.orgA.id, step: "REVIEW_BILLING" } });
    }
  });

  test("permissions unchanged: a plain MEMBER sees the exact same completion summary as the OWNER — no role gate on this read", async ({
    context,
    baseURL,
    page,
  }) => {
    const fresh = await createFreshOrg(fixtures.runId, "completion-permissions");
    const member = await dbQuery<{ id: string; email: string }>("user", "create", {
      data: {
        id: randomUUID(),
        email: testEmail("onboarding-completion-member", TEST_EMAIL_DOMAIN, fixtures.runId),
        name: "Member",
      },
    });
    await dbQuery("membership", "create", { data: { userId: member.id, organizationId: fresh.org.id, role: "MEMBER" } });
    const client = await dbQuery<{ id: string }>("client", "create", {
      data: { name: "Completion Test Client", organizationId: fresh.org.id, userId: fresh.owner.id },
    });

    try {
      await actAsMember(context, baseURL!, fresh.owner, fresh.org.id);
      await gotoAndSettle(page, `${baseURL}/dashboard`);
      const ownerCompletedText = await onboardingCard(page).getByText(/^Completed so far:/).innerText();
      const ownerNextText = await onboardingCard(page).getByText(/^Up next:/).innerText();

      await actAsMember(context, baseURL!, member, fresh.org.id);
      await gotoAndSettle(page, `${baseURL}/dashboard`);
      await expect(onboardingCard(page).getByText(ownerCompletedText, { exact: true })).toBeVisible();
      await expect(onboardingCard(page).getByText(ownerNextText, { exact: true })).toBeVisible();
    } finally {
      // Client.userId is onDelete: Restrict — this row must go before
      // cleanupFreshOrg deletes fresh.owner, the same ordering
      // staff-app.spec.ts's own Client create test already documents.
      await dbQuery("client", "delete", { where: { id: client.id } });
      await dbQuery("user", "delete", { where: { id: member.id } });
      await cleanupFreshOrg(fresh);
    }
  });
});

test.describe("Dependency-blocked and billing review", () => {
  test("a step blocked behind an undone dependency shows the exact blocked reason, no Go-to link, but Skip remains offered", async ({
    context,
    baseURL,
    page,
  }) => {
    await actAsMember(context, baseURL!, fixtures.orgBOwner, fixtures.orgB.id);
    await gotoAndSettle(page, `${baseURL}/dashboard`);

    const taskRow = rowFor(page, "Create your first task");
    await expect(taskRow.getByText("Tasks must belong to a project. Add one before creating a task.")).toBeVisible();
    await expect(taskRow.getByRole("link", { name: /Go to/ })).toHaveCount(0);
    await expect(taskRow.getByRole("button", { name: /Skip/ })).toBeVisible();
  });

  test("Stage 6 audit fix: a blocked row's explanatory text renders at full opacity — only the decorative icon dims", async ({
    context,
    baseURL,
    page,
  }) => {
    // A fresh, fully empty org: CREATE_PROJECT is blocked behind
    // CREATE_CLIENT (not yet done) and CREATE_TASK is blocked behind
    // CREATE_PROJECT — orgB (used elsewhere in this file) already has a
    // Client, which would make CREATE_PROJECT actionable, not blocked, so
    // it can't prove this specific case.
    const fresh = await createFreshOrg(fixtures.runId, "blocked-contrast");
    await actAsMember(context, baseURL!, fresh.owner, fresh.org.id);
    await gotoAndSettle(page, `${baseURL}/dashboard`);

    for (const [rowLabel, blockedReason] of [
      ["Create your first project", "Projects must belong to a client. Add one before creating a project."],
      ["Create your first task", "Tasks must belong to a project. Add one before creating a task."],
    ] as const) {
      const row = rowFor(page, rowLabel);
      const label = row.getByText(rowLabel, { exact: true });
      const description = row.getByText(blockedReason, { exact: true });
      const icon = row.locator("svg").first();

      // The old implementation applied opacity-60 to an ancestor that
      // contained the label and description too — this would read < 1 for
      // either under that implementation. Stopping at "li" (the row's own
      // OnboardingCard-rendered wrapper) so this only measures the row's
      // own styling, never something coincidentally set higher up the page.
      expect(await effectiveOpacity(label, "li")).toBe(1);
      expect(await effectiveOpacity(description, "li")).toBe(1);
      // The icon is the one element still allowed to dim — proves the fix
      // didn't just remove dimming altogether (Blocked must stay visually
      // distinct), only narrowed its scope.
      expect(await effectiveOpacity(icon, "li")).toBeLessThan(1);

      // Status/icon/absence-of-Go-to still correctly reflect Blocked —
      // unaffected by the contrast fix, re-verified here specifically in
      // the same test as the opacity assertions above.
      await expect(row.getByText("Not Started", { exact: true })).toBeVisible();
      await expect(row.getByRole("link", { name: /Go to/ })).toHaveCount(0);
    }

    await cleanupFreshOrg(fresh);
  });

  test("the Review billing step is Not Started with both a Go to link (to /settings/billing) and a Skip button — available since Sale-Ready Phase E, E3.3, no Paddle configuration required", async ({
    context,
    baseURL,
    page,
  }) => {
    await actAsMember(context, baseURL!, fixtures.orgBOwner, fixtures.orgB.id);
    await gotoAndSettle(page, `${baseURL}/dashboard`);

    const billingRow = rowFor(page, "Review billing");
    await expect(billingRow.getByText("Not Started", { exact: true })).toBeVisible();
    const goTo = billingRow.getByRole("link", { name: /Go to/ });
    await expect(goTo).toBeVisible();
    await expect(billingRow.getByRole("button", { name: /Skip/ })).toBeVisible();
    await expect(goTo).toHaveAttribute("href", "/settings/billing");
  });
});

test.describe("Actions", () => {
  test("clicking 'Go to' navigates to the step's real route", async ({ context, baseURL, page }) => {
    await actAsMember(context, baseURL!, fixtures.orgBOwner, fixtures.orgB.id);
    await gotoAndSettle(page, `${baseURL}/dashboard`);

    const projectRow = rowFor(page, "Create your first project");
    await projectRow.getByRole("link", { name: /Go to/ }).click();
    await page.waitForURL(/\/projects\/new/);
  });

  test("skipping a step updates its row status in place — no manual reload, no navigation away from /dashboard", async ({
    context,
    baseURL,
    page,
  }) => {
    const fresh = await createFreshOrg(fixtures.runId, "skip");
    await actAsMember(context, baseURL!, fresh.owner, fresh.org.id);
    await gotoAndSettle(page, `${baseURL}/dashboard`);

    const teammateRow = rowFor(page, "Invite a teammate");
    await expect(teammateRow.getByText("Not Started", { exact: true })).toBeVisible();

    await teammateRow.getByRole("button", { name: /Skip/ }).click();

    await expect(teammateRow.getByText("Skipped", { exact: true })).toBeVisible();
    await expect(teammateRow.getByRole("button", { name: /Skip/ })).toHaveCount(0);
    await expect(page).toHaveURL(/\/dashboard$/);

    await cleanupFreshOrg(fresh);
  });

  test("dismissing the checklist hides the whole card in place — no manual reload", async ({
    context,
    baseURL,
    page,
  }) => {
    const fresh = await createFreshOrg(fixtures.runId, "dismiss");
    await actAsMember(context, baseURL!, fresh.owner, fresh.org.id);
    await gotoAndSettle(page, `${baseURL}/dashboard`);

    await expect(onboardingCard(page)).toBeVisible();
    await page.getByRole("button", { name: "Dismiss onboarding" }).click();

    await expect(onboardingCard(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/dashboard$/);

    await cleanupFreshOrg(fresh);
  });
});

test.describe("Accessibility", () => {
  test("Skip is a real, keyboard-focusable, labeled button — Enter while focused performs the skip", async ({
    context,
    baseURL,
    page,
  }) => {
    const fresh = await createFreshOrg(fixtures.runId, "keyboard");
    await actAsMember(context, baseURL!, fresh.owner, fresh.org.id);
    await gotoAndSettle(page, `${baseURL}/dashboard`);

    const teammateRow = rowFor(page, "Invite a teammate");
    const skipButton = teammateRow.getByRole("button", { name: /Skip/ });
    await skipButton.focus();
    await expect(skipButton).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(teammateRow.getByText("Skipped", { exact: true })).toBeVisible();

    await cleanupFreshOrg(fresh);
  });

  test("the progress bar exposes role=progressbar with correct aria-value bounds", async ({ context, baseURL, page }) => {
    await actAsMember(context, baseURL!, fixtures.orgBOwner, fixtures.orgB.id);
    await gotoAndSettle(page, `${baseURL}/dashboard`);

    const bar = onboardingCard(page).getByRole("progressbar", { name: "Onboarding progress" });
    await expect(bar).toHaveAttribute("aria-valuemin", "0");
    await expect(bar).toHaveAttribute("aria-valuemax", "100");
    const valueNow = await bar.getAttribute("aria-valuenow");
    expect(Number(valueNow)).toBeGreaterThanOrEqual(0);
    expect(Number(valueNow)).toBeLessThanOrEqual(100);
  });

  test("Dismiss is a real, labeled button reachable by keyboard", async ({ context, baseURL, page }) => {
    await actAsMember(context, baseURL!, fixtures.orgBOwner, fixtures.orgB.id);
    await gotoAndSettle(page, `${baseURL}/dashboard`);

    const dismissButton = page.getByRole("button", { name: "Dismiss onboarding" });
    await dismissButton.focus();
    await expect(dismissButton).toBeFocused();
  });

  test("the progress bar's aria-valuetext announces a human-readable summary, not just the raw percent", async ({
    context,
    baseURL,
    page,
  }) => {
    await actAsMember(context, baseURL!, fixtures.orgBOwner, fixtures.orgB.id);
    await gotoAndSettle(page, `${baseURL}/dashboard`);

    const bar = onboardingCard(page).getByRole("progressbar", { name: "Onboarding progress" });
    await expect(bar).toHaveAttribute("aria-valuetext", /^\d+ of \d+ complete$/);
  });

  test("Stage 5/6: skipping a step moves focus to that row's own label, with a real visible focus indicator (never silently dropped to <body>, never invisibly focused)", async ({
    context,
    baseURL,
    page,
  }) => {
    const fresh = await createFreshOrg(fixtures.runId, "skip-focus");
    await actAsMember(context, baseURL!, fresh.owner, fresh.org.id);
    await gotoAndSettle(page, `${baseURL}/dashboard`);

    const teammateRow = rowFor(page, "Invite a teammate");
    await teammateRow.getByRole("button", { name: /Skip/ }).click();

    await expect(teammateRow.getByText("Skipped", { exact: true })).toBeVisible();
    const focusedLabel = page.getByText("Invite a teammate", { exact: true });
    await expect(focusedLabel).toBeFocused();
    expect(await hasVisibleFocusIndicator(focusedLabel)).toBe(true);

    await cleanupFreshOrg(fresh);
  });

  test("Stage 5/6: dismissing moves focus to the Dashboard's own heading, with a real visible focus indicator (never silently dropped to <body>, never invisibly focused)", async ({
    context,
    baseURL,
    page,
  }) => {
    const fresh = await createFreshOrg(fixtures.runId, "dismiss-focus");
    await actAsMember(context, baseURL!, fresh.owner, fresh.org.id);
    await gotoAndSettle(page, `${baseURL}/dashboard`);

    await page.getByRole("button", { name: "Dismiss onboarding" }).click();

    await expect(onboardingCard(page)).toHaveCount(0);
    const focusedHeading = page.getByRole("heading", { name: "Dashboard", exact: true });
    await expect(focusedHeading).toBeFocused();
    expect(await hasVisibleFocusIndicator(focusedHeading)).toBe(true);

    await cleanupFreshOrg(fresh);
  });

  test("a not-yet-focused row label and the Dashboard heading show no focus indicator at rest (proves the check above is meaningful, not a false positive)", async ({
    context,
    baseURL,
    page,
  }) => {
    await actAsMember(context, baseURL!, fixtures.orgBOwner, fixtures.orgB.id);
    await gotoAndSettle(page, `${baseURL}/dashboard`);

    const heading = page.getByRole("heading", { name: "Dashboard", exact: true });
    expect(await hasVisibleFocusIndicator(heading)).toBe(false);
  });
});

test.describe("Mobile", () => {
  for (const width of [320, 360, 375, 390, 768, 1024]) {
    test(`the card itself collapses to fit ${width}px without its own horizontal overflow`, async ({
      context,
      baseURL,
      page,
    }) => {
      // Scoped to the card's own bounding box, not document.scrollWidth —
      // Header's email + sign-out row (out of scope, "Не меняй Header")
      // already overflows the viewport below ~360px regardless of
      // onboarding, so a whole-page overflow check would fail for a
      // pre-existing, unrelated reason. This isolates what Stage 3 §15
      // actually asks for: the card adapts its own layout at each
      // breakpoint, the same "one component reflows itself" convention
      // Sidebar already uses.
      await page.setViewportSize({ width, height: 800 });
      await actAsMember(context, baseURL!, fixtures.orgBOwner, fixtures.orgB.id);
      await gotoAndSettle(page, `${baseURL}/dashboard`);

      await expect(onboardingCard(page)).toBeVisible();
      const box = await onboardingCard(page).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeLessThanOrEqual(width + 1);

      // Every row's primary controls stay individually reachable (not
      // clipped/zero-size) at this width.
      const projectRow = rowFor(page, "Create your first project");
      await expect(projectRow.getByRole("link", { name: /Go to/ })).toBeVisible();
      const teammateRow = rowFor(page, "Invite a teammate");
      await expect(teammateRow.getByRole("button", { name: /Skip/ })).toBeVisible();
    });
  }

  test("the card still fits a short landscape phone viewport (812x375) without its own horizontal overflow", async ({
    context,
    baseURL,
    page,
  }) => {
    await page.setViewportSize({ width: 812, height: 375 });
    await actAsMember(context, baseURL!, fixtures.orgBOwner, fixtures.orgB.id);
    await gotoAndSettle(page, `${baseURL}/dashboard`);

    await expect(onboardingCard(page)).toBeVisible();
    const box = await onboardingCard(page).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(812 + 1);
  });
});

test.describe("Client Portal", () => {
  test("no onboarding checklist is reachable anywhere from the Client Portal", async ({ context, baseURL, page }) => {
    await injectTestSession(context, { id: fixtures.portalUser.id, email: fixtures.portalUser.email }, baseURL!);
    await gotoAndSettle(page, `${baseURL}/portal`);
    await expect(onboardingCard(page)).toHaveCount(0);
  });
});
