import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { createCommentForEntity } from "@/lib/comments/create-comment";
import { deleteComment } from "@/lib/comments/delete-comment";

describe("deleteComment — integration", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(async () => {
    resetAuthMock();
    await prisma.commentMention.deleteMany({});
    await prisma.comment.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
    await prisma.notification.deleteMany({ where: { type: "MENTIONED" } });
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  async function createCommentAs(
    user: { id: string; email: string; name: string },
    organizationId: string,
    body: string,
  ) {
    actAs(user, organizationId);
    const result = await createCommentForEntity({ entityType: "PROJECT", entityId: fixtures.project.id, rawBody: body });
    if (!result.ok) throw new Error("fixture setup failed");
    return result.commentId;
  }

  it("the author can delete their own comment", async () => {
    const commentId = await createCommentAs(fixtures.member, fixtures.orgA.id, "my own comment");
    actAs(fixtures.member, fixtures.orgA.id);

    const result = await deleteComment({ commentId });
    expect(result).toEqual({ ok: true, alreadyDeleted: false });

    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: commentId } });
    expect(comment.deletedAt).not.toBeNull();
    expect(comment.body).toBe("my own comment"); // body is never physically cleared at this layer
  });

  it("OWNER can moderation-delete another member's comment", async () => {
    const commentId = await createCommentAs(fixtures.member, fixtures.orgA.id, "member's comment");
    actAs(fixtures.owner, fixtures.orgA.id);

    const result = await deleteComment({ commentId });
    expect(result).toEqual({ ok: true, alreadyDeleted: false });

    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: commentId } });
    expect(comment.deletedAt).not.toBeNull();

    const activity = await prisma.activity.findFirstOrThrow({
      where: { entityType: "COMMENT", entityId: commentId, action: "DELETED" },
    });
    const metadata = activity.metadata as Record<string, unknown>;
    expect(metadata.moderated).toBe(true);
  });

  it("ADMIN can moderation-delete another member's comment", async () => {
    const commentId = await createCommentAs(fixtures.member, fixtures.orgA.id, "member's comment");
    actAs(fixtures.admin, fixtures.orgA.id);

    const result = await deleteComment({ commentId });
    expect(result).toEqual({ ok: true, alreadyDeleted: false });
  });

  it("a plain MEMBER cannot delete someone else's comment", async () => {
    const commentId = await createCommentAs(fixtures.owner, fixtures.orgA.id, "owner's comment");
    actAs(fixtures.member, fixtures.orgA.id);

    const result = await deleteComment({ commentId });
    expect(result).toEqual({ ok: false, error: "forbidden" });

    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: commentId } });
    expect(comment.deletedAt).toBeNull();
  });

  it("deleting an already-deleted comment is an idempotent no-op — no second Activity row", async () => {
    const commentId = await createCommentAs(fixtures.member, fixtures.orgA.id, "to be deleted twice");
    actAs(fixtures.member, fixtures.orgA.id);

    const first = await deleteComment({ commentId });
    expect(first).toEqual({ ok: true, alreadyDeleted: false });

    const second = await deleteComment({ commentId });
    expect(second).toEqual({ ok: true, alreadyDeleted: true });

    const activityCount = await prisma.activity.count({
      where: { entityType: "COMMENT", entityId: commentId, action: "DELETED" },
    });
    expect(activityCount).toBe(1);
  });

  it("the comment body remains in the database after deletion — never hard-deleted", async () => {
    const commentId = await createCommentAs(fixtures.member, fixtures.orgA.id, "body must survive");
    actAs(fixtures.member, fixtures.orgA.id);
    await deleteComment({ commentId });

    const comment = await prisma.comment.findUnique({ where: { id: commentId } });
    expect(comment).not.toBeNull();
    expect(comment?.body).toBe("body must survive");
  });

  it("deleting a comment never creates a Notification", async () => {
    const commentId = await createCommentAs(
      fixtures.owner,
      fixtures.orgA.id,
      `mentions @[Member](user:${fixtures.member.id})`,
    );
    const notificationCountBeforeDelete = await prisma.notification.count({ where: { type: "MENTIONED" } });
    expect(notificationCountBeforeDelete).toBe(1);

    actAs(fixtures.owner, fixtures.orgA.id);
    await deleteComment({ commentId });

    const notificationCountAfterDelete = await prisma.notification.count({ where: { type: "MENTIONED" } });
    expect(notificationCountAfterDelete).toBe(1); // unchanged — delete itself adds none
  });

  it("CommentMention rows survive a soft delete, for historical integrity", async () => {
    const commentId = await createCommentAs(
      fixtures.owner,
      fixtures.orgA.id,
      `mentions @[Member](user:${fixtures.member.id})`,
    );
    actAs(fixtures.owner, fixtures.orgA.id);
    await deleteComment({ commentId });

    const mentions = await prisma.commentMention.findMany({ where: { commentId } });
    expect(mentions).toHaveLength(1);
  });

  it("records a DELETED Activity row with moderated: false for a self-delete", async () => {
    const commentId = await createCommentAs(fixtures.member, fixtures.orgA.id, "self delete");
    actAs(fixtures.member, fixtures.orgA.id);
    await deleteComment({ commentId });

    const activity = await prisma.activity.findFirstOrThrow({
      where: { entityType: "COMMENT", entityId: commentId, action: "DELETED" },
    });
    const metadata = activity.metadata as Record<string, unknown>;
    expect(metadata.moderated).toBe(false);
    expect(metadata.authorName).toBe(fixtures.member.name);
  });

  it("a nonexistent comment id returns not_found", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await deleteComment({ commentId: "00000000-0000-0000-0000-000000000000" });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("a cross-org comment id is blocked as not_found", async () => {
    const commentId = await createCommentAs(fixtures.owner, fixtures.orgA.id, "orgA comment");
    actAs(fixtures.orgBOwner, fixtures.orgB.id);
    const result = await deleteComment({ commentId });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });
});
