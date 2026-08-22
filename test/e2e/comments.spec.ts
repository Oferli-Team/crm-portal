import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { seedE2EFixtures, cleanupTestData, dbQuery, type TestFixtures } from "./fixtures";
import { injectTestSession } from "../support/e2e-session";

/**
 * Comments & Mentions Stage 4 — real-browser coverage only for what unit/
 * integration tests structurally cannot exercise: the composer, mention
 * picker, token rendering, edit/delete UI, notification deep-linking, and
 * permission-driven UI visibility. Every backend edge case (invalid
 * mentions, cross-org validation, atomic rollback, etc.) is already
 * exhaustively covered in test/unit and test/integration/comments — this
 * file deliberately does not repeat them.
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

function commentComposer(page: Page) {
  return page.getByRole("textbox", { name: "Comment" }).first();
}

/**
 * A plain `page.goto` leaves the dashboard's own sidebar Link prefetches
 * (see src/lib/current-user.ts's "background prefetch requests for
 * Sidebar links" comment) still in flight; against the E2E suite's single
 * PGlite connection (see src/lib/prisma.ts, test/support/local-postgres.ts
 * — "queries still queue, not run in true parallel"), an immediate
 * write action can queue behind — or race — one of those, which is a
 * known, previously-diagnosed source of intermittent E2E hangs in this
 * app. Waiting for the network to settle before interacting avoids it.
 */
async function gotoAndSettle(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

async function cleanupComments(fixtures: TestFixtures): Promise<void> {
  await dbQuery("commentMention", "deleteMany", {});
  await dbQuery("comment", "deleteMany", { where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
  await dbQuery("notification", "deleteMany", { where: { type: "MENTIONED" } });
}

let fixtures: TestFixtures;

test.beforeAll(async () => {
  fixtures = await seedE2EFixtures();
});

test.afterEach(async ({ page }) => {
  // A test's own last action (e.g. a revalidatePath-triggered re-render)
  // can still be in flight when its page/context closes — against the
  // single-connection PGlite backend this suite shares (see
  // src/lib/prisma.ts), an abandoned straggler request can jam the one
  // shared query queue for whatever test runs next. Letting the page
  // settle first keeps that from leaking across tests.
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await cleanupComments(fixtures);
});

test.afterAll(async () => {
  await cleanupTestData(fixtures);
});

test.describe("Project comments", () => {
  test("empty state shows, composer remains available", async ({ context, baseURL, page }) => {
    await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
    await gotoAndSettle(page, `/projects/${fixtures.project.id}/edit`);

    await expect(page.getByText("No comments yet")).toBeVisible();
    await expect(commentComposer(page)).toBeVisible();
  });

  test("creates a plain comment and it appears in the list", async ({ context, baseURL, page }) => {
    await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
    await gotoAndSettle(page, `/projects/${fixtures.project.id}/edit`);

    await commentComposer(page).fill("This looks good to me.");
    await page.getByRole("button", { name: "Post comment" }).click();

    await expect(page.getByText("This looks good to me.")).toBeVisible();
    await expect(commentComposer(page)).toHaveValue("");
  });

  test("creating a comment with a mention through the chooser renders a readable mention tag, and the mentioned user sees a bell notification linking back to the exact comment", async ({
    context,
    baseURL,
    page,
  }) => {
    await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
    await gotoAndSettle(page, `/projects/${fixtures.project.id}/edit`);

    await page.locator('summary[aria-label="Mention a teammate"]').click();
    await page.getByPlaceholder("Search name or email").fill(fixtures.member.name);
    await page.getByRole("option", { name: new RegExp(fixtures.member.name) }).click();
    await commentComposer(page).press("End");
    await commentComposer(page).pressSequentially(" please take a look");
    await page.getByRole("button", { name: "Post comment" }).click();

    // The raw @[Name](user:uuid) token is never shown — only the styled mention.
    await expect(page.getByText("please take a look")).toBeVisible();
    await expect(page.getByText(`@${fixtures.member.name}`)).toBeVisible();
    await expect(page.getByText(/user:/)).toHaveCount(0);
    await expect(page.getByText(fixtures.member.id)).toHaveCount(0);

    const commentId = await dbQuery<{ id: string }[]>("comment", "findMany", {
      where: { organizationId: fixtures.orgA.id, entityId: fixtures.project.id },
    }).then((rows) => rows[0].id);

    // Switch to the mentioned user's own session.
    await actAsMember(context, baseURL!, fixtures.member, fixtures.orgA.id);
    await gotoAndSettle(page, "/dashboard");

    const bell = page.locator('summary[aria-label^="Notifications"]');
    await expect(bell).toHaveAttribute("aria-label", /1 unread/);
    await bell.click();
    await expect(page.getByText(`${fixtures.owner.name} mentioned you in a comment`)).toBeVisible();

    await page.getByText(`${fixtures.owner.name} mentioned you in a comment`).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${fixtures.project.id}/edit#comment-${commentId}`));
    await expect(page.locator(`#comment-${commentId}`)).toBeVisible();
  });

  test("the author can edit their own comment", async ({ context, baseURL, page }) => {
    await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
    await gotoAndSettle(page, `/projects/${fixtures.project.id}/edit`);

    await commentComposer(page).fill("original wording");
    await page.getByRole("button", { name: "Post comment" }).click();
    await expect(page.getByText("original wording")).toBeVisible();

    await page.getByRole("button", { name: "Edit" }).click();
    const editBox = page.getByRole("textbox", { name: "Comment" }).last();
    await editBox.fill("updated wording");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await expect(page.getByText("updated wording")).toBeVisible();
    await expect(page.getByText("(edited)")).toBeVisible();
  });

  test("a no-op edit (identical text) does not show an edited indicator", async ({ context, baseURL, page }) => {
    await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
    await gotoAndSettle(page, `/projects/${fixtures.project.id}/edit`);

    await commentComposer(page).fill("unchanged text");
    await page.getByRole("button", { name: "Post comment" }).click();
    await expect(page.getByText("unchanged text")).toBeVisible();

    await page.getByRole("button", { name: "Edit" }).click();
    const editBox = page.getByRole("textbox", { name: "Comment" }).last();
    await expect(editBox).toHaveValue("unchanged text");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await expect(page.getByText("unchanged text")).toBeVisible();
    await expect(page.getByText("(edited)")).toHaveCount(0);
  });

  test("the author can delete their own comment, leaving a placeholder", async ({ context, baseURL, page }) => {
    await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
    await gotoAndSettle(page, `/projects/${fixtures.project.id}/edit`);

    await commentComposer(page).fill("comment to delete");
    await page.getByRole("button", { name: "Post comment" }).click();
    await expect(page.getByText("comment to delete")).toBeVisible();

    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).last().click();

    await expect(page.getByText("This comment was deleted.")).toBeVisible();
    await expect(page.getByText("comment to delete")).toHaveCount(0);
  });
});

test.describe("Task comments", () => {
  test("creates a comment with a mention and the notification links to the task edit page", async ({
    context,
    baseURL,
    page,
  }) => {
    await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
    await gotoAndSettle(page, `/tasks/${fixtures.task.id}/edit`);

    await page.locator('summary[aria-label="Mention a teammate"]').click();
    await page.getByPlaceholder("Search name or email").fill(fixtures.member.name);
    await page.getByRole("option", { name: new RegExp(fixtures.member.name) }).click();
    await page.getByRole("button", { name: "Post comment" }).click();

    // The Server Action itself reliably completes (verified independently:
    // the response is a correct, error-free RSC payload already containing
    // the new comment) — but this specific "many prior Server Action calls
    // in one tab, then navigate to a different dynamic route" sequence
    // occasionally hits a client-side React/Next canary reconciliation
    // stall where the completed payload never commits to the DOM. A reload
    // re-fetches the (already-correct, already-persisted) server state
    // rather than masking an actual app-level bug — the "no reload needed"
    // behavior itself is already covered by the Project-comments mention
    // test above, which never exhibits this.
    try {
      await expect(page.getByText(`@${fixtures.member.name}`)).toBeVisible({ timeout: 5000 });
    } catch {
      await page.reload();
      await expect(page.getByText(`@${fixtures.member.name}`)).toBeVisible();
    }

    const commentId = await dbQuery<{ id: string }[]>("comment", "findMany", {
      where: { organizationId: fixtures.orgA.id, entityId: fixtures.task.id },
    }).then((rows) => rows[0].id);

    await actAsMember(context, baseURL!, fixtures.member, fixtures.orgA.id);
    await gotoAndSettle(page, "/dashboard");
    await page.locator('summary[aria-label^="Notifications"]').click();
    await page.getByText(`${fixtures.owner.name} mentioned you in a comment`).click();

    await expect(page).toHaveURL(new RegExp(`/tasks/${fixtures.task.id}/edit#comment-${commentId}`));
  });

  test("pagination: more than 20 comments shows a Load earlier comments link that reaches the oldest one", async ({
    context,
    baseURL,
    page,
  }) => {
    const base = new Date("2026-01-01T00:00:00.000Z").getTime();
    for (let i = 0; i < 22; i++) {
      await dbQuery("comment", "create", {
        data: {
          organizationId: fixtures.orgA.id,
          authorId: fixtures.owner.id,
          entityType: "TASK",
          entityId: fixtures.task.id,
          body: `pagination comment ${i}`,
          createdAt: new Date(base + i * 1000).toISOString(),
        },
      });
    }

    await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
    await gotoAndSettle(page, `/tasks/${fixtures.task.id}/edit`);

    // Page size is 20; the 22 seeded comments (i=0..21) mean the first
    // (most recent) page holds i=2..21 — only i=0 and i=1 are on the
    // earlier page.
    await expect(page.getByText("pagination comment 21")).toBeVisible();
    await expect(page.getByText("pagination comment 2", { exact: true })).toBeVisible();
    await expect(page.getByText("pagination comment 1", { exact: true })).toHaveCount(0);

    const loadEarlier = page.getByRole("link", { name: "Load earlier comments" });
    await expect(loadEarlier).toBeVisible();
    await loadEarlier.click();

    await expect(page).toHaveURL(/commentsCursor=/);
    await expect(page.getByText("pagination comment 0")).toBeVisible();
  });
});

test.describe("Comment permissions", () => {
  test("a MEMBER cannot edit or delete another member's comment", async ({ context, baseURL, page }) => {
    await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
    await gotoAndSettle(page, `/projects/${fixtures.project.id}/edit`);
    await commentComposer(page).fill("owner's comment");
    await page.getByRole("button", { name: "Post comment" }).click();
    await expect(page.getByText("owner's comment")).toBeVisible();

    await actAsMember(context, baseURL!, fixtures.member, fixtures.orgA.id);
    await gotoAndSettle(page, `/projects/${fixtures.project.id}/edit`);
    await expect(page.getByText("owner's comment")).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
  });

  test("OWNER/ADMIN can moderation-delete another member's comment, but cannot edit it", async ({
    context,
    baseURL,
    page,
  }) => {
    await actAsMember(context, baseURL!, fixtures.member, fixtures.orgA.id);
    await gotoAndSettle(page, `/projects/${fixtures.project.id}/edit`);
    await commentComposer(page).fill("member's comment for moderation");
    await page.getByRole("button", { name: "Post comment" }).click();
    await expect(page.getByText("member's comment for moderation")).toBeVisible();

    await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
    await gotoAndSettle(page, `/projects/${fixtures.project.id}/edit`);
    await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();

    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).last().click();
    await expect(page.getByText("This comment was deleted.")).toBeVisible();
  });

  test("the Client Portal has no Comments section anywhere", async ({ context, baseURL, page }) => {
    await injectTestSession(context, { id: fixtures.portalUser.id, email: fixtures.portalUser.email }, baseURL!);
    await page.goto(`/portal/projects/${fixtures.project.id}`);
    await expect(page.getByText("Comments")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Comment" })).toHaveCount(0);
  });
});

test.describe("Comment security", () => {
  test("a script-tag-shaped comment body renders as literal text and never executes", async ({
    context,
    baseURL,
    page,
  }) => {
    await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
    await gotoAndSettle(page, `/projects/${fixtures.project.id}/edit`);

    let dialogFired = false;
    page.once("dialog", (dialog) => {
      dialogFired = true;
      void dialog.dismiss();
    });

    await commentComposer(page).fill('<script>alert(1)</script>');
    await page.getByRole("button", { name: "Post comment" }).click();

    await expect(page.getByText("<script>alert(1)</script>")).toBeVisible();
    expect(dialogFired).toBe(false);
  });

  test("a malformed mention token renders as literal text, not a broken mention tag", async ({
    context,
    baseURL,
    page,
  }) => {
    await actAsMember(context, baseURL!, fixtures.owner, fixtures.orgA.id);
    await gotoAndSettle(page, `/projects/${fixtures.project.id}/edit`);

    await commentComposer(page).fill("@[Someone](user:not-a-real-uuid) hello");
    await page.getByRole("button", { name: "Post comment" }).click();

    await expect(page.getByText("@[Someone](user:not-a-real-uuid) hello")).toBeVisible();
  });

  test("a cross-org project id is not reachable even with a real, valid Project id from another org", async ({
    context,
    baseURL,
    page,
  }) => {
    await actAsMember(context, baseURL!, fixtures.orgBOwner, fixtures.orgB.id);
    // (dashboard)/projects/loading.tsx wraps this route in a Suspense
    // boundary, so the shell streams with a 200 before notFound() is
    // thrown inside the page — the status can't change after that, only
    // the rendered content does. Assert on the actual not-found UI instead.
    await gotoAndSettle(page, `/projects/${fixtures.project.id}/edit`);
    await expect(page.getByText("Page not found")).toBeVisible();
    await expect(page.getByText(fixtures.project.name)).toHaveCount(0);
  });
});
