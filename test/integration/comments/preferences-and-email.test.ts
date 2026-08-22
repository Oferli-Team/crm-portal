import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import type { SendEmailFn } from "@/lib/email/resend-client";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { createCommentForEntity } from "@/lib/comments/create-comment";
import { updateNotificationPreference, resetNotificationPreferences, getDisabledInAppTypes } from "@/lib/notifications/preferences";
import { getUnreadNotificationCount } from "@/lib/notifications/queries";
import { deliverNotificationEmails } from "@/lib/notifications/email/deliver-notification-email";

const TEST_FROM_EMAIL = "Test <test@example.com>";
const ORIGINAL_FROM_EMAIL = process.env.INVITATION_FROM_EMAIL;

function setFromEmail(value: string | undefined): void {
  if (value === undefined) delete process.env.INVITATION_FROM_EMAIL;
  else process.env.INVITATION_FROM_EMAIL = value;
}

const okSend: SendEmailFn = async () => ({ ok: true });

describe("Comments & Mentions — preferences and email delivery integration", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
    setFromEmail(TEST_FROM_EMAIL);
  });

  afterEach(async () => {
    resetAuthMock();
    setFromEmail(TEST_FROM_EMAIL);
    await resetNotificationPreferences(fixtures.member.id);
    await prisma.commentMention.deleteMany({});
    await prisma.comment.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
    await prisma.notification.deleteMany({ where: { type: "MENTIONED" } });
  });

  afterAll(async () => {
    setFromEmail(ORIGINAL_FROM_EMAIL);
    await cleanupTestData(fixtures);
  });

  async function createMentionComment() {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await createCommentForEntity({
      entityType: "PROJECT",
      entityId: fixtures.project.id,
      rawBody: `Hey @[Member](user:${fixtures.member.id}), please review.`,
    });
    if (!result.ok) throw new Error("fixture setup failed");
    return result.commentId;
  }

  it("MENTIONED with in-app disabled: the Notification row exists but is excluded from the unread count", async () => {
    await updateNotificationPreference(fixtures.member.id, "MENTIONED", { inAppEnabled: false });
    await createMentionComment();

    const row = await prisma.notification.findFirstOrThrow({
      where: { type: "MENTIONED", recipientId: fixtures.member.id, organizationId: fixtures.orgA.id },
    });
    expect(row).not.toBeNull();

    const excludeTypes = await getDisabledInAppTypes(fixtures.member.id);
    expect(excludeTypes).toContain("MENTIONED");

    const unreadCount = await getUnreadNotificationCount({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
      excludeTypes,
    });
    expect(unreadCount).toBe(0);

    const unreadCountWithoutFilter = await getUnreadNotificationCount({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
    });
    expect(unreadCountWithoutFilter).toBe(1);
  });

  it("MENTIONED with email disabled: the delivery is SKIPPED", async () => {
    await updateNotificationPreference(fixtures.member.id, "MENTIONED", { emailEnabled: false });
    const commentId = await createMentionComment();

    const notification = await prisma.notification.findFirstOrThrow({
      where: { type: "MENTIONED", recipientId: fixtures.member.id, organizationId: fixtures.orgA.id, entityId: commentId },
    });
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: notification.id, channel: "EMAIL" } },
    });
    expect(delivery.status).toBe("SKIPPED");
    expect(delivery.failureCode).toBe("disabled_by_preference");
  });

  it("provider not configured: the delivery is SKIPPED safely, no throw, comment still exists", async () => {
    setFromEmail(undefined);
    const commentId = await createMentionComment();

    const notification = await prisma.notification.findFirstOrThrow({
      where: { type: "MENTIONED", recipientId: fixtures.member.id, organizationId: fixtures.orgA.id, entityId: commentId },
    });
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: notification.id, channel: "EMAIL" } },
    });
    expect(delivery.status).toBe("SKIPPED");
    expect(delivery.failureCode).toBe("not_configured");

    const comment = await prisma.comment.findUnique({ where: { id: commentId } });
    expect(comment).not.toBeNull();
  });

  it("a provider failure during post-commit delivery never rolls back the comment, its mentions, or its Activity", async () => {
    const commentId = await createMentionComment();
    // The comment/mention/activity are already committed by this point;
    // re-running delivery with a failing provider must only ever affect
    // the NotificationDelivery row.
    const failSend: SendEmailFn = async () => ({ ok: false, reason: "provider_error" });
    const notification = await prisma.notification.findFirstOrThrow({
      where: { type: "MENTIONED", recipientId: fixtures.member.id, organizationId: fixtures.orgA.id, entityId: commentId },
    });
    await prisma.notificationDelivery.deleteMany({ where: { notificationId: notification.id } });

    await deliverNotificationEmails([notification.id], { sendEmail: failSend });

    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: commentId } });
    expect(comment).not.toBeNull();
    const mentions = await prisma.commentMention.findMany({ where: { commentId } });
    expect(mentions).toHaveLength(1);
    const activity = await prisma.activity.findFirstOrThrow({ where: { entityType: "COMMENT", entityId: commentId } });
    expect(activity).not.toBeNull();

    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: notification.id, channel: "EMAIL" } },
    });
    expect(delivery.status).toBe("FAILED");
  });

  it("a successful mocked provider marks the delivery SENT", async () => {
    const commentId = await createMentionComment();
    const notification = await prisma.notification.findFirstOrThrow({
      where: { type: "MENTIONED", recipientId: fixtures.member.id, organizationId: fixtures.orgA.id, entityId: commentId },
    });
    await prisma.notificationDelivery.deleteMany({ where: { notificationId: notification.id } });
    const spy = vi.fn(okSend);

    await deliverNotificationEmails([notification.id], { sendEmail: spy });

    expect(spy).toHaveBeenCalledTimes(1);
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: notification.id, channel: "EMAIL" } },
    });
    expect(delivery.status).toBe("SENT");
  });
});
