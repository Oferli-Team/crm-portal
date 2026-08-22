import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { testEmail } from "../../support/run-id";
import { TEST_EMAIL_DOMAIN } from "../../support/env";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { createCommentForEntity } from "@/lib/comments/create-comment";
import { COMMENT_BODY_MAX_LENGTH } from "@/lib/comments/validate-body";
import { createActivity } from "@/lib/activity/create-activity";

// Mocking prisma.activity.create directly doesn't work here: createActivity
// is always called with a transaction-scoped `tx` client (a different
// object from the top-level `prisma` singleton), so a vi.spyOn on the
// top-level client's method never intercepts it. Wrapping the imported
// createActivity function itself — the same technique setup-mocks.ts
// already uses for @/lib/rate-limit — intercepts it regardless of which
// client it was called with.
vi.mock("@/lib/activity/create-activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/activity/create-activity")>();
  return { ...actual, createActivity: vi.fn(actual.createActivity) };
});

const TEST_FROM_EMAIL = "Test <test@example.com>";
const ORIGINAL_FROM_EMAIL = process.env.INVITATION_FROM_EMAIL;

describe("createCommentForEntity — integration", () => {
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
  });

  afterAll(async () => {
    process.env.INVITATION_FROM_EMAIL = ORIGINAL_FROM_EMAIL;
    await cleanupTestData(fixtures);
  });

  it("creates a Project comment", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await createCommentForEntity({
      entityType: "PROJECT",
      entityId: fixtures.project.id,
      rawBody: "A project comment",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: result.commentId } });
    expect(comment.entityType).toBe("PROJECT");
    expect(comment.entityId).toBe(fixtures.project.id);
    expect(comment.organizationId).toBe(fixtures.orgA.id);
    expect(comment.authorId).toBe(fixtures.owner.id);
    expect(comment.body).toBe("A project comment");
  });

  it("creates a Task comment", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await createCommentForEntity({
      entityType: "TASK",
      entityId: fixtures.task.id,
      rawBody: "A task comment",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: result.commentId } });
    expect(comment.entityType).toBe("TASK");
    expect(comment.entityId).toBe(fixtures.task.id);
  });

  it("records a COMMENT/CREATED Activity row atomically with the comment", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await createCommentForEntity({
      entityType: "PROJECT",
      entityId: fixtures.project.id,
      rawBody: "Hello",
    });
    if (!result.ok) throw new Error("expected success");

    const activity = await prisma.activity.findFirstOrThrow({
      where: { entityType: "COMMENT", entityId: result.commentId },
    });
    expect(activity.action).toBe("CREATED");
    expect(activity.organizationId).toBe(fixtures.orgA.id);
    expect(activity.actorId).toBe(fixtures.owner.id);
    const metadata = activity.metadata as Record<string, unknown>;
    expect(metadata.parentEntityType).toBe("PROJECT");
    expect(metadata.parentEntityLabel).toBe(fixtures.project.name);
    expect(metadata.commentPreview).toBe("Hello");
  });

  it("a Project id belonging to a different organization is blocked, indistinguishable from nonexistent", async () => {
    actAs(fixtures.orgBOwner, fixtures.orgB.id);
    const result = await createCommentForEntity({
      entityType: "PROJECT",
      entityId: fixtures.project.id, // belongs to orgA
      rawBody: "Should not be created",
    });
    expect(result).toEqual({ ok: false, error: "not_found" });

    const count = await prisma.comment.count({ where: { entityId: fixtures.project.id } });
    expect(count).toBe(0);
  });

  it("a nonexistent entityId is blocked the same way as a cross-org one", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await createCommentForEntity({
      entityType: "PROJECT",
      entityId: "00000000-0000-0000-0000-000000000000",
      rawBody: "Should not be created",
    });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("author is always the current session's user, never client-suppliable", async () => {
    actAs(fixtures.member, fixtures.orgA.id);
    const result = await createCommentForEntity({
      entityType: "PROJECT",
      entityId: fixtures.project.id,
      rawBody: "From member",
    });
    if (!result.ok) throw new Error("expected success");
    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: result.commentId } });
    expect(comment.authorId).toBe(fixtures.member.id);
  });

  it("rejects an empty body", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await createCommentForEntity({ entityType: "PROJECT", entityId: fixtures.project.id, rawBody: "   " });
    expect(result).toEqual({ ok: false, error: "empty_body" });
  });

  it("rejects a body over the max length", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await createCommentForEntity({
      entityType: "PROJECT",
      entityId: fixtures.project.id,
      rawBody: "a".repeat(COMMENT_BODY_MAX_LENGTH + 1),
    });
    expect(result).toEqual({ ok: false, error: "body_too_long" });
  });

  it("a valid mention of a real org member creates a CommentMention row and a MENTIONED Notification", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await createCommentForEntity({
      entityType: "PROJECT",
      entityId: fixtures.project.id,
      rawBody: `Hey @[Member](user:${fixtures.member.id}), please review.`,
    });
    if (!result.ok) throw new Error("expected success");

    const mentions = await prisma.commentMention.findMany({ where: { commentId: result.commentId } });
    expect(mentions).toHaveLength(1);
    expect(mentions[0].userId).toBe(fixtures.member.id);

    const notification = await prisma.notification.findFirstOrThrow({
      where: { type: "MENTIONED", recipientId: fixtures.member.id, organizationId: fixtures.orgA.id },
    });
    expect(notification.entityType).toBe("COMMENT");
    expect(notification.entityId).toBe(result.commentId);
    const metadata = notification.metadata as Record<string, unknown>;
    expect(metadata.parentEntityLabel).toBe(fixtures.project.name);
    expect(metadata.parentEntityType).toBe("PROJECT");

    await prisma.notification.deleteMany({ where: { id: notification.id } });
  });

  it("mentioning yourself (the actor) never creates a Mention or a Notification", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await createCommentForEntity({
      entityType: "PROJECT",
      entityId: fixtures.project.id,
      rawBody: `Note to self @[Me](user:${fixtures.owner.id})`,
    });
    if (!result.ok) throw new Error("expected success");

    const mentions = await prisma.commentMention.findMany({ where: { commentId: result.commentId } });
    expect(mentions).toHaveLength(0);
    const notification = await prisma.notification.findFirst({
      where: { type: "MENTIONED", recipientId: fixtures.owner.id, organizationId: fixtures.orgA.id },
    });
    expect(notification).toBeNull();
  });

  it("duplicate mention tokens of the same user produce exactly one Mention and one Notification", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await createCommentForEntity({
      entityType: "PROJECT",
      entityId: fixtures.project.id,
      rawBody: `@[Member](user:${fixtures.member.id}) thanks — @[Member](user:${fixtures.member.id}) again`,
    });
    if (!result.ok) throw new Error("expected success");

    const mentions = await prisma.commentMention.findMany({ where: { commentId: result.commentId } });
    expect(mentions).toHaveLength(1);

    const notifications = await prisma.notification.findMany({
      where: { type: "MENTIONED", recipientId: fixtures.member.id, organizationId: fixtures.orgA.id },
    });
    expect(notifications).toHaveLength(1);

    await prisma.notification.deleteMany({ where: { id: { in: notifications.map((n) => n.id) } } });
  });

  it("mentioning a user from a different organization is silently ignored — comment still succeeds", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await createCommentForEntity({
      entityType: "PROJECT",
      entityId: fixtures.project.id,
      rawBody: `Hey @[Cross Org](user:${fixtures.orgBOwner.id}), please review.`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const mentions = await prisma.commentMention.findMany({ where: { commentId: result.commentId } });
    expect(mentions).toHaveLength(0);
    const notification = await prisma.notification.findFirst({
      where: { type: "MENTIONED", recipientId: fixtures.orgBOwner.id },
    });
    expect(notification).toBeNull();
  });

  it("mentioning a User id with no Membership at all in this org is silently ignored", async () => {
    const noMembershipUser = await prisma.user.create({
      data: { email: testEmail("no-membership", TEST_EMAIL_DOMAIN, fixtures.runId), name: "No Membership" },
    });

    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await createCommentForEntity({
      entityType: "PROJECT",
      entityId: fixtures.project.id,
      rawBody: `Hey @[No Membership](user:${noMembershipUser.id})`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const mentions = await prisma.commentMention.findMany({ where: { commentId: result.commentId } });
    expect(mentions).toHaveLength(0);

    await prisma.user.delete({ where: { id: noMembershipUser.id } });
  });

  it("a mention of a nonexistent user id (never a real User row) is silently ignored", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await createCommentForEntity({
      entityType: "PROJECT",
      entityId: fixtures.project.id,
      rawBody: "Hey @[Nobody](user:00000000-0000-4000-8000-000000000000)",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mentions = await prisma.commentMention.findMany({ where: { commentId: result.commentId } });
    expect(mentions).toHaveLength(0);
  });

  it("atomic rollback: a failure inside the transaction leaves no Comment, CommentMention, or Activity row behind", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    vi.mocked(createActivity).mockRejectedValueOnce(new Error("simulated failure"));

    await expect(
      createCommentForEntity({
        entityType: "PROJECT",
        entityId: fixtures.project.id,
        rawBody: `Hey @[Member](user:${fixtures.member.id})`,
      }),
    ).rejects.toThrow("simulated failure");

    const comments = await prisma.comment.findMany({ where: { organizationId: fixtures.orgA.id, entityId: fixtures.project.id } });
    expect(comments).toHaveLength(0);
    const mentions = await prisma.commentMention.count();
    expect(mentions).toBe(0);
  });
});
