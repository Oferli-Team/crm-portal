import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { testEmail } from "../../support/run-id";
import { TEST_EMAIL_DOMAIN } from "../../support/env";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { createCommentForEntity } from "@/lib/comments/create-comment";
import { editComment } from "@/lib/comments/edit-comment";
import { deleteComment } from "@/lib/comments/delete-comment";
import { getMentionCandidates, MENTION_CANDIDATE_LIMIT } from "@/lib/comments/mention-candidates";
import { resolveCommentPermissions, formatCommentViewModel } from "@/lib/comments/format-comment";
import { formatNotification } from "@/lib/notifications/format-notification";
import { buildActivityWhere } from "@/app/(dashboard)/activity/query";

const TEST_FROM_EMAIL = "Test <test@example.com>";
const ORIGINAL_FROM_EMAIL = process.env.INVITATION_FROM_EMAIL;

describe("Comments & Mentions Stage 4 — UI-support integration", () => {
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

  describe("getMentionCandidates", () => {
    it("returns only staff members of the given organization", async () => {
      const candidates = await getMentionCandidates(fixtures.orgA.id);
      const ids = candidates.map((c) => c.id);
      expect(ids).toContain(fixtures.owner.id);
      expect(ids).toContain(fixtures.admin.id);
      expect(ids).toContain(fixtures.member.id);
      expect(ids).not.toContain(fixtures.orgBOwner.id);
    });

    it("never includes a PortalUser — structurally impossible, since Membership has no relation to it", async () => {
      const candidates = await getMentionCandidates(fixtures.orgA.id);
      const ids = candidates.map((c) => c.id);
      expect(ids).not.toContain(fixtures.portalUser.id);
    });

    it("includes name and email for each candidate", async () => {
      const candidates = await getMentionCandidates(fixtures.orgA.id);
      const ownerCandidate = candidates.find((c) => c.id === fixtures.owner.id);
      expect(ownerCandidate).toEqual({ id: fixtures.owner.id, name: fixtures.owner.name, email: fixtures.owner.email });
    });

    it("is bounded at MENTION_CANDIDATE_LIMIT even if the org has more members", async () => {
      const extraUsers = await Promise.all(
        Array.from({ length: MENTION_CANDIDATE_LIMIT + 5 }, (_, i) =>
          prisma.user.create({ data: { email: testEmail(`mention-candidate-${i}`, TEST_EMAIL_DOMAIN, fixtures.runId), name: `Extra ${i}` } }),
        ),
      );
      await prisma.membership.createMany({
        data: extraUsers.map((u) => ({ userId: u.id, organizationId: fixtures.orgA.id, role: "MEMBER" as const })),
      });

      const candidates = await getMentionCandidates(fixtures.orgA.id);
      expect(candidates.length).toBeLessThanOrEqual(MENTION_CANDIDATE_LIMIT);

      await prisma.membership.deleteMany({ where: { userId: { in: extraUsers.map((u) => u.id) } } });
      await prisma.user.deleteMany({ where: { id: { in: extraUsers.map((u) => u.id) } } });
    });
  });

  describe("notification link resolver — real end-to-end", () => {
    it("a real MENTIONED notification resolves to the project edit page with a #comment fragment", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const result = await createCommentForEntity({
        entityType: "PROJECT",
        entityId: fixtures.project.id,
        rawBody: `Hey @[Member](user:${fixtures.member.id})`,
      });
      if (!result.ok) throw new Error("fixture setup failed");

      const notification = await prisma.notification.findFirstOrThrow({
        where: { type: "MENTIONED", recipientId: fixtures.member.id, organizationId: fixtures.orgA.id },
      });
      const formatted = formatNotification({
        type: notification.type,
        metadata: notification.metadata,
        entityId: notification.entityId,
        createdAt: notification.createdAt,
        readAt: notification.readAt,
      });
      expect(formatted.link).toBe(`/projects/${fixtures.project.id}/edit#comment-${result.commentId}`);
    });

    it("a real MENTIONED notification for a Task comment resolves to the task edit page", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const result = await createCommentForEntity({
        entityType: "TASK",
        entityId: fixtures.task.id,
        rawBody: `Hey @[Member](user:${fixtures.member.id})`,
      });
      if (!result.ok) throw new Error("fixture setup failed");

      const notification = await prisma.notification.findFirstOrThrow({
        where: { type: "MENTIONED", recipientId: fixtures.member.id, organizationId: fixtures.orgA.id },
      });
      const formatted = formatNotification({
        type: notification.type,
        metadata: notification.metadata,
        entityId: notification.entityId,
        createdAt: notification.createdAt,
        readAt: notification.readAt,
      });
      expect(formatted.link).toBe(`/tasks/${fixtures.task.id}/edit#comment-${result.commentId}`);
    });

    it("a deleted comment's notification link still resolves — the destination page renders a placeholder, not a 404", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const createResult = await createCommentForEntity({
        entityType: "PROJECT",
        entityId: fixtures.project.id,
        rawBody: `Hey @[Member](user:${fixtures.member.id})`,
      });
      if (!createResult.ok) throw new Error("fixture setup failed");

      await deleteComment({ commentId: createResult.commentId });

      const notification = await prisma.notification.findFirstOrThrow({
        where: { type: "MENTIONED", recipientId: fixtures.member.id, organizationId: fixtures.orgA.id },
      });
      const formatted = formatNotification({
        type: notification.type,
        metadata: notification.metadata,
        entityId: notification.entityId,
        createdAt: notification.createdAt,
        readAt: notification.readAt,
      });
      expect(formatted.link).toBe(`/projects/${fixtures.project.id}/edit#comment-${createResult.commentId}`);

      // Confirm the destination row really is a safe placeholder, not raw body.
      const commentRow = await prisma.comment.findUniqueOrThrow({
        where: { id: createResult.commentId },
        include: { author: { select: { name: true } }, mentions: { select: { userId: true } } },
      });
      const viewModel = formatCommentViewModel(commentRow);
      expect(viewModel.isDeleted).toBe(true);
      expect(viewModel.placeholder).toBe("This comment was deleted.");
    });

    it("the target Project/Task page's own ownership check (organizationId scoping) denies a cross-org lookup even with a real, valid id", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const result = await createCommentForEntity({
        entityType: "PROJECT",
        entityId: fixtures.project.id,
        rawBody: `Hey @[Member](user:${fixtures.member.id})`,
      });
      if (!result.ok) throw new Error("fixture setup failed");

      // Mirrors exactly what EditProjectPage itself does — the real
      // ownership boundary a MENTIONED link's destination page enforces,
      // independent of anything in the notification/link itself.
      const crossOrgLookup = await prisma.project.findFirst({
        where: { id: fixtures.project.id, organizationId: fixtures.orgB.id },
      });
      expect(crossOrgLookup).toBeNull();

      const sameOrgLookup = await prisma.project.findFirst({
        where: { id: fixtures.project.id, organizationId: fixtures.orgA.id },
      });
      expect(sameOrgLookup).not.toBeNull();
    });
  });

  describe("resolveCommentPermissions matches real backend behavior", () => {
    it("canEdit=true predicts a real editComment success; canEdit=false predicts a real forbidden result", async () => {
      actAs(fixtures.member, fixtures.orgA.id);
      const createResult = await createCommentForEntity({
        entityType: "PROJECT",
        entityId: fixtures.project.id,
        rawBody: "member's own comment",
      });
      if (!createResult.ok) throw new Error("fixture setup failed");

      const commentRow = await prisma.comment.findUniqueOrThrow({
        where: { id: createResult.commentId },
        include: { author: { select: { name: true } }, mentions: { select: { userId: true } } },
      });
      const viewModel = formatCommentViewModel(commentRow);

      // Author's own view: predicted editable.
      const authorPermissions = resolveCommentPermissions(viewModel, fixtures.member.id, false);
      expect(authorPermissions.canEdit).toBe(true);
      actAs(fixtures.member, fixtures.orgA.id);
      const authorEditResult = await editComment({ commentId: createResult.commentId, rawBody: "edited by author" });
      expect(authorEditResult.ok).toBe(true);

      // A different, non-moderator viewer: predicted not editable, and the real backend agrees.
      const viewerPermissions = resolveCommentPermissions(viewModel, fixtures.owner.id, false);
      expect(viewerPermissions.canEdit).toBe(false);
      actAs(fixtures.owner, fixtures.orgA.id);
      const viewerEditResult = await editComment({ commentId: createResult.commentId, rawBody: "hijack attempt" });
      expect(viewerEditResult).toEqual({ ok: false, error: "forbidden" });
    });

    it("canDelete=true for a moderator predicts a real successful moderation delete", async () => {
      actAs(fixtures.member, fixtures.orgA.id);
      const createResult = await createCommentForEntity({
        entityType: "PROJECT",
        entityId: fixtures.project.id,
        rawBody: "member's own comment for moderation test",
      });
      if (!createResult.ok) throw new Error("fixture setup failed");

      const commentRow = await prisma.comment.findUniqueOrThrow({
        where: { id: createResult.commentId },
        include: { author: { select: { name: true } }, mentions: { select: { userId: true } } },
      });
      const viewModel = formatCommentViewModel(commentRow);

      const ownerPermissions = resolveCommentPermissions(viewModel, fixtures.owner.id, true);
      expect(ownerPermissions.canDelete).toBe(true);

      actAs(fixtures.owner, fixtures.orgA.id);
      const deleteResult = await deleteComment({ commentId: createResult.commentId });
      expect(deleteResult).toEqual({ ok: true, alreadyDeleted: false });
    });

    it("canDelete=false for a non-moderator, non-author predicts a real forbidden delete", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const createResult = await createCommentForEntity({
        entityType: "PROJECT",
        entityId: fixtures.project.id,
        rawBody: "owner's own comment",
      });
      if (!createResult.ok) throw new Error("fixture setup failed");

      const commentRow = await prisma.comment.findUniqueOrThrow({
        where: { id: createResult.commentId },
        include: { author: { select: { name: true } }, mentions: { select: { userId: true } } },
      });
      const viewModel = formatCommentViewModel(commentRow);

      const memberPermissions = resolveCommentPermissions(viewModel, fixtures.member.id, false);
      expect(memberPermissions.canDelete).toBe(false);

      actAs(fixtures.member, fixtures.orgA.id);
      const deleteResult = await deleteComment({ commentId: createResult.commentId });
      expect(deleteResult).toEqual({ ok: false, error: "forbidden" });
    });
  });

  describe("Activity 'data' action group includes Comment events", () => {
    it("a COMMENT/CREATED Activity row is included when filtering by the 'data' action group", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const result = await createCommentForEntity({
        entityType: "PROJECT",
        entityId: fixtures.project.id,
        rawBody: "for activity group test",
      });
      if (!result.ok) throw new Error("fixture setup failed");

      const where = buildActivityWhere(fixtures.orgA.id, { actionGroup: "data", cursor: null, cursorInvalid: false });
      const rows = await prisma.activity.findMany({
        where: { ...where, entityType: "COMMENT", entityId: result.commentId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe("CREATED");
    });
  });
});
