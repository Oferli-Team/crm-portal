import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { seedE2EFixtures, cleanupTestData, dbQuery, type TestFixtures } from "./fixtures";
import { injectTestSession } from "../support/e2e-session";

// D. Invitation acceptance — the staff (organization Membership) lifecycle;
// the Client Portal invitation lifecycle is already covered by Stage 3/4's
// integration tests (test/integration/invitations*). fixtures.invitation was
// seeded PENDING for a brand-new email with no User row yet — TEST_MODE lets
// us inject a fresh, matching identity for it without a real signup.

let fixtures: TestFixtures;
let inviteeId: string;

test.beforeAll(async () => {
  fixtures = await seedE2EFixtures();
  inviteeId = randomUUID();
});

test.afterEach(async () => {
  // Independent of cleanupTestData below, which only knows about the
  // originally-seeded fixture rows — this ad-hoc invitee User/Membership
  // is created live by the accept flow itself and would otherwise leak
  // across runs.
  await dbQuery("membership", "deleteMany", { where: { userId: inviteeId } });
  await dbQuery("user", "deleteMany", { where: { id: inviteeId } });
});

test.afterAll(async () => {
  await cleanupTestData(fixtures);
});

test("accepting an invitation creates the Membership, and re-opening the link shows a safe already-accepted state", async ({ page, context, baseURL }) => {
  await injectTestSession(context, { id: inviteeId, email: fixtures.invitation.email }, baseURL!);

  await page.goto(`/invite/${fixtures.invitation.token}`);
  await expect(page.getByRole("heading", { name: "You're invited" })).toBeVisible();
  await expect(page.getByText(fixtures.invitation.email, { exact: false })).toBeVisible();

  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST"),
    page.getByRole("button", { name: "Accept invitation" }).click(),
  ]);
  await expect(page).toHaveURL(/\/dashboard/);

  const membership = await dbQuery<{ organizationId: string; role: string } | null>(
    "membership",
    "findUnique",
    { where: { userId_organizationId: { userId: inviteeId, organizationId: fixtures.orgA.id } } },
  );
  expect(membership).not.toBeNull();
  expect(membership!.organizationId).toBe(fixtures.orgA.id);

  const invitation = await dbQuery<{ status: string }>("invitation", "findUniqueOrThrow", {
    where: { id: fixtures.invitation.id },
  });
  expect(invitation.status).toBe("ACCEPTED");

  // Re-opening the same link must never re-run the accept transaction —
  // it should render a safe, generic "already accepted" state instead.
  await page.goto(`/invite/${fixtures.invitation.token}`);
  await expect(page.getByRole("heading", { name: "Invitation already accepted" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to dashboard" })).toBeVisible();
});
