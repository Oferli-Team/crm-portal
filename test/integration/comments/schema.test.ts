import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { testEmail } from "../../support/run-id";
import { TEST_EMAIL_DOMAIN } from "../../support/env";

// Comments & Mentions Stage 2 (docs/comments-architecture.md): schema-level
// only — no Server Action, no fan-out, no parser exists yet, so these tests
// exercise the Comment/CommentMention Prisma models directly, the same way
// this file's sibling suites test Attachment mutations against real
// PGlite. Stage 3 adds the business-logic integration suite this one is
// deliberately not trying to be.
describe("Comment/CommentMention schema — integration", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("creates a PROJECT comment", async () => {
    const comment = await prisma.comment.create({
      data: {
        organizationId: fixtures.orgA.id,
        authorId: fixtures.owner.id,
        entityType: "PROJECT",
        entityId: fixtures.project.id,
        body: "A project comment",
      },
    });
    expect(comment.entityType).toBe("PROJECT");
    expect(comment.deletedAt).toBeNull();
    expect(comment.editedAt).toBeNull();

    await prisma.comment.delete({ where: { id: comment.id } });
  });

  it("creates a TASK comment", async () => {
    const comment = await prisma.comment.create({
      data: {
        organizationId: fixtures.orgA.id,
        authorId: fixtures.owner.id,
        entityType: "TASK",
        entityId: fixtures.task.id,
        body: "A task comment",
      },
    });
    expect(comment.entityType).toBe("TASK");

    await prisma.comment.delete({ where: { id: comment.id } });
  });

  it("allows an entityId with no backing Project/Task row — entityId is not a foreign key", async () => {
    const comment = await prisma.comment.create({
      data: {
        organizationId: fixtures.orgA.id,
        authorId: fixtures.owner.id,
        entityType: "PROJECT",
        entityId: randomUUID(),
        body: "Points at nothing real",
      },
    });
    expect(comment.id).toBeDefined();

    await prisma.comment.delete({ where: { id: comment.id } });
  });

  it("deleting the author sets authorId to null and the comment survives", async () => {
    const disposableUser = await prisma.user.create({
      data: { email: testEmail("comment-author-delete", TEST_EMAIL_DOMAIN, fixtures.runId), name: "Disposable Author" },
    });
    await prisma.membership.create({
      data: { userId: disposableUser.id, organizationId: fixtures.orgA.id, role: "MEMBER" },
    });
    const comment = await prisma.comment.create({
      data: {
        organizationId: fixtures.orgA.id,
        authorId: disposableUser.id,
        entityType: "PROJECT",
        entityId: fixtures.project.id,
        body: "Will lose its author",
      },
    });

    await prisma.user.delete({ where: { id: disposableUser.id } });

    const afterDelete = await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } });
    expect(afterDelete.authorId).toBeNull();
    expect(afterDelete.body).toBe("Will lose its author");

    await prisma.comment.delete({ where: { id: comment.id } });
  });

  it("rejects a duplicate (commentId, userId) CommentMention with P2002", async () => {
    const comment = await prisma.comment.create({
      data: {
        organizationId: fixtures.orgA.id,
        authorId: fixtures.owner.id,
        entityType: "PROJECT",
        entityId: fixtures.project.id,
        body: "Mentions someone",
      },
    });
    await prisma.commentMention.create({ data: { commentId: comment.id, userId: fixtures.member.id } });

    await expect(
      prisma.commentMention.create({ data: { commentId: comment.id, userId: fixtures.member.id } }),
    ).rejects.toThrow();

    await prisma.comment.delete({ where: { id: comment.id } });
  });

  it("allows the same User to be mentioned in two different comments", async () => {
    const commentA = await prisma.comment.create({
      data: { organizationId: fixtures.orgA.id, authorId: fixtures.owner.id, entityType: "PROJECT", entityId: fixtures.project.id, body: "first" },
    });
    const commentB = await prisma.comment.create({
      data: { organizationId: fixtures.orgA.id, authorId: fixtures.owner.id, entityType: "TASK", entityId: fixtures.task.id, body: "second" },
    });

    await prisma.commentMention.create({ data: { commentId: commentA.id, userId: fixtures.member.id } });
    const secondMention = await prisma.commentMention.create({ data: { commentId: commentB.id, userId: fixtures.member.id } });
    expect(secondMention.id).toBeDefined();

    await prisma.comment.deleteMany({ where: { id: { in: [commentA.id, commentB.id] } } });
  });

  it("deleting a Comment cascades its CommentMention rows", async () => {
    const comment = await prisma.comment.create({
      data: { organizationId: fixtures.orgA.id, authorId: fixtures.owner.id, entityType: "PROJECT", entityId: fixtures.project.id, body: "cascade test" },
    });
    const mention = await prisma.commentMention.create({ data: { commentId: comment.id, userId: fixtures.member.id } });

    await prisma.comment.delete({ where: { id: comment.id } });

    const goneMention = await prisma.commentMention.findUnique({ where: { id: mention.id } });
    expect(goneMention).toBeNull();
  });

  it("deleting the mentioned User cascades the CommentMention row but leaves the Comment intact", async () => {
    const disposableUser = await prisma.user.create({
      data: { email: testEmail("comment-mention-delete", TEST_EMAIL_DOMAIN, fixtures.runId), name: "Disposable Mentioned" },
    });
    await prisma.membership.create({
      data: { userId: disposableUser.id, organizationId: fixtures.orgA.id, role: "MEMBER" },
    });
    const comment = await prisma.comment.create({
      data: { organizationId: fixtures.orgA.id, authorId: fixtures.owner.id, entityType: "PROJECT", entityId: fixtures.project.id, body: "mentions a soon-to-be-deleted user" },
    });
    const mention = await prisma.commentMention.create({ data: { commentId: comment.id, userId: disposableUser.id } });

    await prisma.user.delete({ where: { id: disposableUser.id } });

    const goneMention = await prisma.commentMention.findUnique({ where: { id: mention.id } });
    const stillThereComment = await prisma.comment.findUnique({ where: { id: comment.id } });
    expect(goneMention).toBeNull();
    expect(stillThereComment).not.toBeNull();

    await prisma.comment.delete({ where: { id: comment.id } });
  });

  it("soft delete: setting deletedAt never removes the row or clears body at the schema level", async () => {
    const comment = await prisma.comment.create({
      data: { organizationId: fixtures.orgA.id, authorId: fixtures.owner.id, entityType: "TASK", entityId: fixtures.task.id, body: "about to be soft-deleted" },
    });

    const deletedAt = new Date();
    await prisma.comment.update({ where: { id: comment.id }, data: { deletedAt } });

    const afterSoftDelete = await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } });
    expect(afterSoftDelete.deletedAt).not.toBeNull();
    expect(afterSoftDelete.body).toBe("about to be soft-deleted");

    await prisma.comment.delete({ where: { id: comment.id } });
  });

  it("a PortalUser id cannot be used as CommentMention.userId — no matching User row exists for it", async () => {
    const comment = await prisma.comment.create({
      data: { organizationId: fixtures.orgA.id, authorId: fixtures.owner.id, entityType: "PROJECT", entityId: fixtures.project.id, body: "portal FK test" },
    });

    await expect(
      prisma.commentMention.create({ data: { commentId: comment.id, userId: fixtures.portalUser.id } }),
    ).rejects.toThrow();

    await prisma.comment.delete({ where: { id: comment.id } });
  });

  it("deleting the Organization cascades both Comment and CommentMention rows", async () => {
    const disposableOrg = await prisma.organization.create({
      data: { name: "Disposable Org", slug: `disposable-org-${fixtures.runId}` },
    });
    const disposableUser = await prisma.user.create({
      data: { email: testEmail("comment-org-cascade", TEST_EMAIL_DOMAIN, fixtures.runId), name: "Disposable Org User" },
    });
    await prisma.membership.create({ data: { userId: disposableUser.id, organizationId: disposableOrg.id, role: "OWNER" } });

    const comment = await prisma.comment.create({
      data: { organizationId: disposableOrg.id, authorId: disposableUser.id, entityType: "PROJECT", entityId: randomUUID(), body: "org cascade test" },
    });
    const mention = await prisma.commentMention.create({ data: { commentId: comment.id, userId: disposableUser.id } });

    await prisma.organization.delete({ where: { id: disposableOrg.id } });

    const goneComment = await prisma.comment.findUnique({ where: { id: comment.id } });
    const goneMention = await prisma.commentMention.findUnique({ where: { id: mention.id } });
    expect(goneComment).toBeNull();
    expect(goneMention).toBeNull();

    await prisma.user.delete({ where: { id: disposableUser.id } });
  });

  it("cross-entity-type comments on the same organization are independently scoped", async () => {
    const projectComment = await prisma.comment.create({
      data: { organizationId: fixtures.orgA.id, authorId: fixtures.owner.id, entityType: "PROJECT", entityId: fixtures.project.id, body: "project side" },
    });
    const taskComment = await prisma.comment.create({
      data: { organizationId: fixtures.orgA.id, authorId: fixtures.owner.id, entityType: "TASK", entityId: fixtures.task.id, body: "task side" },
    });

    const projectComments = await prisma.comment.findMany({
      where: { organizationId: fixtures.orgA.id, entityType: "PROJECT", entityId: fixtures.project.id },
    });
    expect(projectComments.map((c) => c.id)).toContain(projectComment.id);
    expect(projectComments.map((c) => c.id)).not.toContain(taskComment.id);

    await prisma.comment.deleteMany({ where: { id: { in: [projectComment.id, taskComment.id] } } });
  });
});
