import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { seedE2EFixtures, cleanupTestData, dbQuery, type TestFixtures } from "./fixtures";
import { injectTestSession } from "../support/e2e-session";
import { testEmail, testSlug } from "../support/run-id";
import { TEST_EMAIL_DOMAIN } from "../support/env";

/**
 * Stage 7.1.2 — First Value Moment. Real-browser coverage for the
 * improved Clients/Projects/Tasks empty states (src/app/(dashboard)/
 * clients|projects|tasks/page.tsx) — each now explains what the entity
 * is for and offers a "Create your first X" CTA, using the exact same
 * existing routes/actions the old "Add X" CTA already pointed at. No new
 * route, no new Server Action, no onboarding-engine change (see
 * src/lib/onboarding/ — untouched). This file covers what genuinely
 * needs a real browser: the new copy actually renders for a fresh
 * workspace, both an OWNER and a plain MEMBER can act on it identically
 * (flat access, same as every existing Client/Project/Task Server
 * Action), and the Client Portal's own separate empty states/routes are
 * unaffected.
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

/** A brand-new organization with zero business data — mirrors onboarding-ui.spec.ts's own createFreshOrg. */
async function createFreshOrg(runId: string, label: string): Promise<FreshOrg> {
  const org = await dbQuery<{ id: string }>("organization", "create", {
    data: { name: `Fresh ${label}`, slug: testSlug(`first-value-${label}`, runId) },
  });
  const owner = await dbQuery<{ id: string; email: string }>("user", "create", {
    data: { id: randomUUID(), email: testEmail(`first-value-${label}-owner`, TEST_EMAIL_DOMAIN, runId), name: "Owner" },
  });
  await dbQuery("membership", "create", { data: { userId: owner.id, organizationId: org.id, role: "OWNER" } });
  return { org, owner };
}

/** Organization delete cascades Membership; the User row is separate. */
async function cleanupFreshOrg({ org, owner }: FreshOrg): Promise<void> {
  await dbQuery("organization", "delete", { where: { id: org.id } });
  await dbQuery("user", "delete", { where: { id: owner.id } });
}

type FreshPortalIdentity = { client: { id: string }; portalUser: { id: string; email: string } };

/**
 * A brand-new portal identity whose Client has zero Projects/Invoices —
 * fixtures.portalUser (clientA) already has real Project/Invoice rows
 * from seedTestData(), so it can't prove the Portal's own empty state.
 * Identical to portal-welcome.spec.ts's own createFreshPortalIdentity,
 * including that helper's own precedent of only ever deleting the
 * portalUser/client rows at the call site, not the owning org/user —
 * harmless debris in the E2E run's own throwaway PGlite database.
 */
async function createFreshPortalIdentity(runId: string, label: string): Promise<FreshPortalIdentity> {
  const org = await dbQuery<{ id: string }>("organization", "create", {
    data: { name: `Fresh ${label}`, slug: testSlug(`first-value-portal-${label}`, runId) },
  });
  const owner = await dbQuery<{ id: string }>("user", "create", {
    data: { id: randomUUID(), email: testEmail(`first-value-portal-${label}-owner`, TEST_EMAIL_DOMAIN, runId), name: "Owner" },
  });
  await dbQuery("membership", "create", { data: { userId: owner.id, organizationId: org.id, role: "OWNER" } });
  const client = await dbQuery<{ id: string }>("client", "create", {
    data: { name: `Fresh ${label} Client`, organizationId: org.id, userId: owner.id },
  });
  const portalUser = await dbQuery<{ id: string; email: string }>("portalUser", "create", {
    data: { id: randomUUID(), clientId: client.id, email: testEmail(`first-value-portal-${label}-user`, TEST_EMAIL_DOMAIN, runId), name: "Fresh Portal User" },
  });
  return { client, portalUser };
}

let fixtures: TestFixtures;

test.beforeAll(async () => {
  fixtures = await seedE2EFixtures();
});

test.afterAll(async () => {
  await cleanupTestData(fixtures);
});

test.describe("Fresh workspace empty states", () => {
  test("Clients: explains purpose and offers 'Create your first client'", async ({ context, baseURL, page }) => {
    const fresh = await createFreshOrg(fixtures.runId, "clients-empty");
    await actAsMember(context, baseURL!, fresh.owner, fresh.org.id);
    await gotoAndSettle(page, `${baseURL}/clients`);

    await expect(page.getByText("No clients yet")).toBeVisible();
    await expect(
      page.getByText(
        "Clients are the people and businesses you work with — add your first one to start creating projects, tracking tasks, and sending invoices.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Create your first client" })).toHaveAttribute("href", "/clients/new");

    await cleanupFreshOrg(fresh);
  });

  test("Projects: explains purpose and offers 'Create your first project' once a client exists", async ({
    context,
    baseURL,
    page,
  }) => {
    const fresh = await createFreshOrg(fixtures.runId, "projects-empty");
    const client = await dbQuery<{ id: string }>("client", "create", {
      data: { name: "First Value Client", organizationId: fresh.org.id, userId: fresh.owner.id },
    });

    try {
      await actAsMember(context, baseURL!, fresh.owner, fresh.org.id);
      await gotoAndSettle(page, `${baseURL}/projects`);

      await expect(page.getByText("No projects yet")).toBeVisible();
      await expect(
        page.getByText(
          "Projects organize your work for a client — group related tasks together and track progress from start to finish.",
        ),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: "Create your first project" })).toHaveAttribute("href", "/projects/new");
    } finally {
      await dbQuery("client", "delete", { where: { id: client.id } });
      await cleanupFreshOrg(fresh);
    }
  });

  test("Tasks: explains purpose and offers 'Create your first task' once a project exists", async ({
    context,
    baseURL,
    page,
  }) => {
    const fresh = await createFreshOrg(fixtures.runId, "tasks-empty");
    const client = await dbQuery<{ id: string }>("client", "create", {
      data: { name: "First Value Client", organizationId: fresh.org.id, userId: fresh.owner.id },
    });
    const project = await dbQuery<{ id: string }>("project", "create", {
      data: { name: "First Value Project", clientId: client.id, ownerId: fresh.owner.id, organizationId: fresh.org.id },
    });

    try {
      await actAsMember(context, baseURL!, fresh.owner, fresh.org.id);
      await gotoAndSettle(page, `${baseURL}/tasks`);

      await expect(page.getByText("No tasks yet")).toBeVisible();
      await expect(
        page.getByText("Tasks break a project down into the specific work you need to track and complete."),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: "Create your first task" })).toHaveAttribute("href", "/tasks/new");
    } finally {
      await dbQuery("project", "delete", { where: { id: project.id } });
      await dbQuery("client", "delete", { where: { id: client.id } });
      await cleanupFreshOrg(fresh);
    }
  });
});

test.describe("OWNER can create first entities from the empty-state CTA", () => {
  test("the whole first-value chain: create the first client, then project, then task, each replacing its own empty state", async ({
    context,
    baseURL,
    page,
  }) => {
    const fresh = await createFreshOrg(fixtures.runId, "owner-chain");
    await actAsMember(context, baseURL!, fresh.owner, fresh.org.id);

    try {
      // Client.
      await gotoAndSettle(page, `${baseURL}/clients`);
      await page.getByRole("link", { name: "Create your first client" }).click();
      await page.waitForURL(/\/clients\/new/);
      // exact: true — the Client form's Billing details subsection
      // (Invoice System Slice 1) added a "Billing legal name" field,
      // making the default substring match for "Name" ambiguous.
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("First Value Client");
      await Promise.all([
        page.waitForResponse((r) => r.url().includes("/clients/new") && r.request().method() === "POST"),
        page.getByRole("button", { name: "Create client" }).click(),
      ]);
      await expect(page).toHaveURL(/\/clients(\?|$)/);
      await expect(page.getByText("No clients yet")).toHaveCount(0);
      await expect(page.getByRole("cell", { name: "First Value Client" })).toBeVisible();

      // Project.
      await gotoAndSettle(page, `${baseURL}/projects`);
      await page.getByRole("link", { name: "Create your first project" }).click();
      await page.waitForURL(/\/projects\/new/);
      await page.getByLabel("Name").fill("First Value Project");
      await page.getByLabel("Client").selectOption({ label: "First Value Client" });
      await Promise.all([
        page.waitForResponse((r) => r.url().includes("/projects/new") && r.request().method() === "POST"),
        page.getByRole("button", { name: "Create project" }).click(),
      ]);
      await expect(page).toHaveURL(/\/projects(\?|$)/);
      await expect(page.getByText("No projects yet")).toHaveCount(0);
      await expect(page.getByRole("cell", { name: "First Value Project" })).toBeVisible();

      // Task.
      await gotoAndSettle(page, `${baseURL}/tasks`);
      await page.getByRole("link", { name: "Create your first task" }).click();
      await page.waitForURL(/\/tasks\/new/);
      await page.getByLabel("Title").fill("First Value Task");
      await page.getByLabel("Project").selectOption({ label: "First Value Project — First Value Client" });
      await Promise.all([
        page.waitForResponse((r) => r.url().includes("/tasks/new") && r.request().method() === "POST"),
        page.getByRole("button", { name: "Create task" }).click(),
      ]);
      await expect(page).toHaveURL(/\/tasks(\?|$)/);
      await expect(page.getByText("No tasks yet")).toHaveCount(0);
      await expect(page.getByRole("cell", { name: "First Value Task" })).toBeVisible();
    } finally {
      await dbQuery("task", "deleteMany", { where: { organizationId: fresh.org.id } });
      await dbQuery("project", "deleteMany", { where: { organizationId: fresh.org.id } });
      await dbQuery("client", "deleteMany", { where: { organizationId: fresh.org.id } });
      await cleanupFreshOrg(fresh);
    }
  });
});

test.describe("Permissions unchanged", () => {
  test("a plain MEMBER sees the identical empty state and can also create the first client — flat access, no role gate", async ({
    context,
    baseURL,
    page,
  }) => {
    const fresh = await createFreshOrg(fixtures.runId, "member-permissions");
    const member = await dbQuery<{ id: string; email: string }>("user", "create", {
      data: { id: randomUUID(), email: testEmail("first-value-member", TEST_EMAIL_DOMAIN, fixtures.runId), name: "Member" },
    });
    await dbQuery("membership", "create", { data: { userId: member.id, organizationId: fresh.org.id, role: "MEMBER" } });

    try {
      await actAsMember(context, baseURL!, member, fresh.org.id);
      await gotoAndSettle(page, `${baseURL}/clients`);

      await expect(page.getByText("No clients yet")).toBeVisible();
      await expect(page.getByRole("link", { name: "Create your first client" })).toBeVisible();

      await page.getByRole("link", { name: "Create your first client" }).click();
      await page.waitForURL(/\/clients\/new/);
      // exact: true — the Client form's Billing details subsection
      // (Invoice System Slice 1) added a "Billing legal name" field,
      // making the default substring match for "Name" ambiguous.
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("Member Created Client");
      await Promise.all([
        page.waitForResponse((r) => r.url().includes("/clients/new") && r.request().method() === "POST"),
        page.getByRole("button", { name: "Create client" }).click(),
      ]);
      await expect(page).toHaveURL(/\/clients(\?|$)/);
      await expect(page.getByRole("cell", { name: "Member Created Client" })).toBeVisible();
    } finally {
      await dbQuery("client", "deleteMany", { where: { organizationId: fresh.org.id } });
      await dbQuery("user", "delete", { where: { id: member.id } });
      await cleanupFreshOrg(fresh);
    }
  });
});

test.describe("Client Portal unaffected", () => {
  test("a Client Portal identity is redirected away from /clients, /projects, and /tasks — the new empty-state copy is never reachable", async ({
    context,
    baseURL,
    page,
  }) => {
    await injectTestSession(context, { id: fixtures.portalUser.id, email: fixtures.portalUser.email }, baseURL!);

    for (const path of ["/clients", "/projects", "/tasks"]) {
      await gotoAndSettle(page, `${baseURL}${path}`);
      await expect(page).toHaveURL(/\/portal$/);
    }
  });

  test("the Portal's own Projects/Invoices empty states keep their own, different copy — untouched by this stage", async ({
    context,
    baseURL,
    page,
  }) => {
    // fixtures.portalUser's client (clientA) already has a real Project
    // (seedTestData()) — a fresh identity with zero data is required to
    // actually see the Portal's own empty state, same as
    // portal-welcome.spec.ts's own equivalent test.
    const fresh = await createFreshPortalIdentity(fixtures.runId, "empty-state");
    await injectTestSession(context, fresh.portalUser, baseURL!);

    await gotoAndSettle(page, `${baseURL}/portal/projects`);
    await expect(page.getByText("No projects yet")).toBeVisible();
    await expect(page.getByText("Projects will appear here once your team adds one.")).toBeVisible();
    await expect(page.getByText("Create your first project")).toHaveCount(0);

    await gotoAndSettle(page, `${baseURL}/portal/invoices`);
    await expect(page.getByText("No invoices", { exact: true })).toBeVisible();
    await expect(page.getByText("Invoices will appear here once your team creates one.")).toBeVisible();

    await dbQuery("portalUser", "delete", { where: { id: fresh.portalUser.id } });
    await dbQuery("client", "delete", { where: { id: fresh.client.id } });
  });
});
