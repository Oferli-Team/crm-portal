import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { createCommentForEntity } from "@/lib/comments/create-comment";
import { editComment } from "@/lib/comments/edit-comment";

const TEST_FROM_EMAIL = "Test <test@example.com>";
const ORIGINAL_FROM_EMAIL = process.env.INVITATION_FROM_EMAIL;

describe("editComment — integration", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
    process.env.INVITATION_FROM_EMAIL = TEST_FROM_EMAIL;
  });

  afterEach(async () => {
    resetAuthMock();
    process.env.INVITATION_FROM_EMAIL = TEST_FROM_EMAIL;
    await prisma.commentMention.deleteMany({});
    await prisma.comment.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
    await prisma.notification.deleteMany({ where: { type: "MENTIONED" } });
  });

  afterAll(async () => {
    process.env.INVITATION_FROM_EMAIL = ORIGINAL_FROM_EMAIL;
    await cleanupTestData(fixtures);
  });

  async function createOwnedComment(body: string) {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await createCommentForEntity({ entityType: "PROJECT", entityId: fixtures.project.id, rawBody: body });
    if (!result.ok) throw new Error("fixture setup failed");
    return result.commentId;
  }

  it("the author can edit their own comment", async () => {
    const commentId = await createOwnedComment("original text");
    actAs(fixtures.owner, fixtures.orgA.id);

    const result = await editComment({ commentId, rawBody: "updated text" });
    expect(result).toEqual({ ok: true, commentId, noop: false });

    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: commentId } });
    expect(comment.body).toBe("updated text");
    expect(comment.editedAt).not.toBeNull();
  });

  it("a non-author MEMBER cannot edit someone else's comment", async () => {
    const commentId = await createOwnedComment("original text");
    actAs(fixtures.member, fixtures.orgA.id);

    const result = await editComment({ commentId, rawBody: "hijacked text" });
    expect(result).toEqual({ ok: false, error: "forbidden" });

    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: commentId } });
    expect(comment.body).toBe("original text");
  });

  it("OWNER cannot edit someone else's comment either — author-only, no role override", async () => {
    actAs(fixtures.member, fixtures.orgA.id);
    const createResult = await createCommentForEntity({
      entityType: "PROJECT",
      entityId: fixtures.project.id,
      rawBody: "member's own words",
    });
    if (!createResult.ok) throw new Error("fixture setup failed");

    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await editComment({ commentId: createResult.commentId, rawBody: "owner tries to edit" });
    expect(result).toEqual({ ok: false, error: "forbidden" });
  });

  it("ADMIN cannot edit someone else's comment either", async () => {
    actAs(fixtures.member, fixtures.orgA.id);
    const createResult = await createCommentForEntity({
      entityType: "PROJECT",
      entityId: fixtures.project.id,
      rawBody: "member's own words",
    });
    if (!createResult.ok) throw new Error("fixture setup failed");

    actAs(fixtures.admin, fixtures.orgA.id);
    const result = await editComment({ commentId: createResult.commentId, rawBody: "admin tries to edit" });
    expect(result).toEqual({ ok: false, error: "forbidden" });
  });

  it("adding a mention on edit notifies the newly-added user", async () => {
    const commentId = await createOwnedComment("no mentions yet");
    actAs(fixtures.owner, fixtures.orgA.id);

    const result = await editComment({
      commentId,
      rawBody: `now mentioning @[Member](user:${fixtures.member.id})`,
    });
    expect(result.ok).toBe(true);

    const mentions = await prisma.commentMention.findMany({ where: { commentId } });
    expect(mentions.map((m) => m.userId)).toEqual([fixtures.member.id]);

    const notification = await prisma.notification.findFirstOrThrow({
      where: { type: "MENTIONED", recipientId: fixtures.member.id, organizationId: fixtures.orgA.id },
    });
    expect(notification.entityId).toBe(commentId);
  });

  it("an unchanged mention across an edit does not produce a second notification", async () => {
    const commentId = await createOwnedComment(`hey @[Member](user:${fixtures.member.id})`);
    const firstNotificationCount = await prisma.notification.count({ where: { type: "MENTIONED" } });
    expect(firstNotificationCount).toBe(1);

    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await editComment({
      commentId,
      rawBody: `hey @[Member](user:${fixtures.member.id}) — small wording change`,
    });
    expect(result.ok).toBe(true);

    const mentions = await prisma.commentMention.findMany({ where: { commentId } });
    expect(mentions).toHaveLength(1);
    const notificationCount = await prisma.notification.count({ where: { type: "MENTIONED" } });
    expect(notificationCount).toBe(1);
  });

  it("removing a mention on edit deletes the CommentMention row and produces no new notification", async () => {
    const commentId = await createOwnedComment(`hey @[Member](user:${fixtures.member.id})`);

    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await editComment({ commentId, rawBody: "no more mentions here" });
    expect(result.ok).toBe(true);

    const mentions = await prisma.commentMention.findMany({ where: { commentId } });
    expect(mentions).toHaveLength(0);
    const notificationCount = await prisma.notification.count({ where: { type: "MENTIONED" } });
    expect(notificationCount).toBe(1); // only the original creation's notification
  });

  it("a true no-op edit (identical body, identical mentions) writes nothing", async () => {
    const commentId = await createOwnedComment(`same text @[Member](user:${fixtures.member.id})`);
    const before = await prisma.comment.findUniqueOrThrow({ where: { id: commentId } });
    const activityCountBefore = await prisma.activity.count({ where: { entityType: "COMMENT", entityId: commentId } });

    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await editComment({ commentId, rawBody: `same text @[Member](user:${fixtures.member.id})` });
    expect(result).toEqual({ ok: true, commentId, noop: true });

    const after = await prisma.comment.findUniqueOrThrow({ where: { id: commentId } });
    expect(after.editedAt).toBeNull();
    expect(after.updatedAt).toEqual(before.updatedAt);
    const activityCountAfter = await prisma.activity.count({ where: { entityType: "COMMENT", entityId: commentId } });
    expect(activityCountAfter).toBe(activityCountBefore);
    const notificationCount = await prisma.notification.count({ where: { type: "MENTIONED" } });
    expect(notificationCount).toBe(1); // only from the original create, none from the no-op edit
  });

  it("a deleted comment cannot be edited", async () => {
    const commentId = await createOwnedComment("will be deleted");
    await prisma.comment.update({ where: { id: commentId }, data: { deletedAt: new Date() } });

    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await editComment({ commentId, rawBody: "trying to edit a deleted comment" });
    expect(result).toEqual({ ok: false, error: "deleted" });
  });

  it("editing a comment records a COMMENT/UPDATED Activity row with add/remove mention counts", async () => {
    const commentId = await createOwnedComment("initial");
    actAs(fixtures.owner, fixtures.orgA.id);
    await editComment({ commentId, rawBody: `edited @[Member](user:${fixtures.member.id})` });

    const activity = await prisma.activity.findFirstOrThrow({
      where: { entityType: "COMMENT", entityId: commentId, action: "UPDATED" },
    });
    const metadata = activity.metadata as Record<string, unknown>;
    expect(metadata.addedMentionCount).toBe(1);
    expect(metadata.removedMentionCount).toBe(0);
    expect(metadata.mentionCount).toBe(1);
  });

  it("editing a comment belonging to another organization is blocked (not_found)", async () => {
    const commentId = await createOwnedComment("orgA comment");
    actAs(fixtures.orgBOwner, fixtures.orgB.id);
    const result = await editComment({ commentId, rawBody: "cross-org edit attempt" });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });
});
