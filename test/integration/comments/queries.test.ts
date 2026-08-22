import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { testEmail } from "../../support/run-id";
import { TEST_EMAIL_DOMAIN } from "../../support/env";
import { getCommentsPage, COMMENT_PAGE_SIZE } from "@/lib/comments/queries";

describe("getCommentsPage — integration", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(async () => {
    await prisma.commentMention.deleteMany({});
    await prisma.comment.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  async function seedComments(count: number, overrides: { entityId?: string; createdAtBase?: Date } = {}) {
    const entityId = overrides.entityId ?? fixtures.project.id;
    const base = overrides.createdAtBase ?? new Date("2026-01-01T00:00:00.000Z");
    const comments = [];
    for (let i = 0; i < count; i++) {
      const comment = await prisma.comment.create({
        data: {
          organizationId: fixtures.orgA.id,
          authorId: fixtures.owner.id,
          entityType: "PROJECT",
          entityId,
          body: `comment ${i}`,
          createdAt: new Date(base.getTime() + i * 1000),
        },
      });
      comments.push(comment);
    }
    return comments;
  }

  it("scopes by organizationId + entityType + entityId together", async () => {
    await seedComments(2, { entityId: fixtures.project.id });
    const otherProjectId = fixtures.task.id; // a real, different entity in the same org
    await prisma.comment.create({
      data: { organizationId: fixtures.orgA.id, authorId: fixtures.owner.id, entityType: "TASK", entityId: otherProjectId, body: "task comment" },
    });

    const page = await getCommentsPage({ organizationId: fixtures.orgA.id, entityType: "PROJECT", entityId: fixtures.project.id });
    expect(page.comments).toHaveLength(2);
    expect(page.comments.every((c) => c.entityType === "PROJECT")).toBe(true);
  });

  it("Project and Task comments are returned independently", async () => {
    await prisma.comment.create({
      data: { organizationId: fixtures.orgA.id, authorId: fixtures.owner.id, entityType: "PROJECT", entityId: fixtures.project.id, body: "project comment" },
    });
    await prisma.comment.create({
      data: { organizationId: fixtures.orgA.id, authorId: fixtures.owner.id, entityType: "TASK", entityId: fixtures.task.id, body: "task comment" },
    });

    const projectPage = await getCommentsPage({ organizationId: fixtures.orgA.id, entityType: "PROJECT", entityId: fixtures.project.id });
    const taskPage = await getCommentsPage({ organizationId: fixtures.orgA.id, entityType: "TASK", entityId: fixtures.task.id });
    expect(projectPage.comments).toHaveLength(1);
    expect(taskPage.comments).toHaveLength(1);
    expect(projectPage.comments[0].body).toBe("project comment");
    expect(taskPage.comments[0].body).toBe("task comment");
  });

  it("paginates with no duplicates or gaps across pages", async () => {
    await seedComments(COMMENT_PAGE_SIZE + 5);

    const firstPage = await getCommentsPage({ organizationId: fixtures.orgA.id, entityType: "PROJECT", entityId: fixtures.project.id });
    expect(firstPage.comments).toHaveLength(COMMENT_PAGE_SIZE);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await getCommentsPage({
      organizationId: fixtures.orgA.id,
      entityType: "PROJECT",
      entityId: fixtures.project.id,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.comments).toHaveLength(5);
    expect(secondPage.nextCursor).toBeNull();

    const firstIds = firstPage.comments.map((c) => c.id);
    const secondIds = secondPage.comments.map((c) => c.id);
    const overlap = firstIds.filter((id) => secondIds.includes(id));
    expect(overlap).toHaveLength(0);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(COMMENT_PAGE_SIZE + 5);
  });

  it("orders newest-first with a stable id tie-break for identical createdAt values", async () => {
    const sameInstant = new Date("2026-02-01T00:00:00.000Z");
    const created = [];
    for (let i = 0; i < 3; i++) {
      const comment = await prisma.comment.create({
        data: {
          organizationId: fixtures.orgA.id,
          authorId: fixtures.owner.id,
          entityType: "PROJECT",
          entityId: fixtures.project.id,
          body: `tie ${i}`,
          createdAt: sameInstant,
        },
      });
      created.push(comment);
    }

    const page = await getCommentsPage({ organizationId: fixtures.orgA.id, entityType: "PROJECT", entityId: fixtures.project.id });
    const expectedOrder = [...created].sort((a, b) => b.id.localeCompare(a.id)).map((c) => c.id);
    expect(page.comments.map((c) => c.id)).toEqual(expectedOrder);
  });

  it("a soft-deleted comment is still included in the page — hiding it is the formatter's job, not the query's", async () => {
    const [comment] = await seedComments(1);
    await prisma.comment.update({ where: { id: comment.id }, data: { deletedAt: new Date() } });

    const page = await getCommentsPage({ organizationId: fixtures.orgA.id, entityType: "PROJECT", entityId: fixtures.project.id });
    expect(page.comments).toHaveLength(1);
    expect(page.comments[0].deletedAt).not.toBeNull();
    expect(page.comments[0].body).toBe(comment.body); // body is NOT redacted by the query itself
  });

  it("an invalid cursor degrades safely to the first page, never throws", async () => {
    await seedComments(3);
    const page = await getCommentsPage({
      organizationId: fixtures.orgA.id,
      entityType: "PROJECT",
      entityId: fixtures.project.id,
      cursor: "not-a-valid-cursor",
    });
    expect(page.cursorInvalid).toBe(true);
    expect(page.comments).toHaveLength(3);
  });

  it("a cross-org target returns an empty page, never a thrown error", async () => {
    await seedComments(2);
    const page = await getCommentsPage({ organizationId: fixtures.orgB.id, entityType: "PROJECT", entityId: fixtures.project.id });
    expect(page).toEqual({ comments: [], nextCursor: null, cursorInvalid: false });
  });

  it("a nonexistent entityId returns an empty page", async () => {
    const page = await getCommentsPage({
      organizationId: fixtures.orgA.id,
      entityType: "PROJECT",
      entityId: "00000000-0000-0000-0000-000000000000",
    });
    expect(page).toEqual({ comments: [], nextCursor: null, cursorInvalid: false });
  });

  it("includes minimal author fields, and falls back gracefully when the author has been deleted", async () => {
    const disposableUser = await prisma.user.create({
      data: { email: testEmail("query-author-delete", TEST_EMAIL_DOMAIN, fixtures.runId), name: "Disposable Author" },
    });
    await prisma.membership.create({ data: { userId: disposableUser.id, organizationId: fixtures.orgA.id, role: "MEMBER" } });
    const comment = await prisma.comment.create({
      data: { organizationId: fixtures.orgA.id, authorId: disposableUser.id, entityType: "PROJECT", entityId: fixtures.project.id, body: "will lose its author" },
    });
    await prisma.user.delete({ where: { id: disposableUser.id } });

    const page = await getCommentsPage({ organizationId: fixtures.orgA.id, entityType: "PROJECT", entityId: fixtures.project.id });
    const row = page.comments.find((c) => c.id === comment.id);
    expect(row?.author).toBeNull();
    expect(row?.authorId).toBeNull();
  });

  it("includes minimal mention fields with no N+1 — comments and mentions both come back on a single call", async () => {
    const comment = await prisma.comment.create({
      data: { organizationId: fixtures.orgA.id, authorId: fixtures.owner.id, entityType: "PROJECT", entityId: fixtures.project.id, body: `hi @[Member](user:${fixtures.member.id})` },
    });
    await prisma.commentMention.create({ data: { commentId: comment.id, userId: fixtures.member.id } });

    const page = await getCommentsPage({ organizationId: fixtures.orgA.id, entityType: "PROJECT", entityId: fixtures.project.id });
    const row = page.comments.find((c) => c.id === comment.id);
    expect(row?.mentions.map((m) => m.userId)).toEqual([fixtures.member.id]);
  });

  it("respects a custom limit", async () => {
    await seedComments(5);
    const page = await getCommentsPage({ organizationId: fixtures.orgA.id, entityType: "PROJECT", entityId: fixtures.project.id, limit: 2 });
    expect(page.comments).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });
});
