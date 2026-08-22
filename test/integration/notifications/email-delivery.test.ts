import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { Role } from "@/generated/prisma/enums";
import type { SendEmailFn } from "@/lib/email/resend-client";
import { createActivity } from "@/lib/activity/create-activity";
import { deliverNotificationEmails } from "@/lib/notifications/email/deliver-notification-email";
import { buildRoleChangedMetadata } from "@/lib/activity/team-metadata";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { testEmail } from "../../support/run-id";
import { TEST_EMAIL_DOMAIN } from "../../support/env";

const TEST_FROM_EMAIL = "Test <test@example.com>";
const ORIGINAL_FROM_EMAIL = process.env.INVITATION_FROM_EMAIL;

function setFromEmail(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.INVITATION_FROM_EMAIL;
  } else {
    process.env.INVITATION_FROM_EMAIL = value;
  }
}

async function createNotification(overrides: {
  organizationId: string;
  recipientId: string;
  type?: "ROLE_CHANGED" | "INVOICE_STATUS_CHANGED";
}) {
  return prisma.notification.create({
    data: {
      organizationId: overrides.organizationId,
      recipientId: overrides.recipientId,
      type: overrides.type ?? "ROLE_CHANGED",
      metadata: { actorName: "Jane Doe", from: "MEMBER", to: "ADMIN" },
    },
  });
}

const okSend: SendEmailFn = async () => ({ ok: true });
const failSend: SendEmailFn = async () => ({ ok: false, reason: "provider_error" });

describe("deliverNotificationEmails — integration", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
    setFromEmail(TEST_FROM_EMAIL);
  });

  afterEach(() => {
    setFromEmail(TEST_FROM_EMAIL);
  });

  afterAll(async () => {
    setFromEmail(ORIGINAL_FROM_EMAIL);
    await cleanupTestData(fixtures);
  });

  it("creates a NotificationDelivery row for an allowlisted, eligible notification", async () => {
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });

    await deliverNotificationEmails([n.id], { sendEmail: okSend });

    const delivery = await prisma.notificationDelivery.findUnique({
      where: { notificationId_channel: { notificationId: n.id, channel: "EMAIL" } },
    });
    expect(delivery).not.toBeNull();
    expect(delivery?.channel).toBe("EMAIL");

    await prisma.notification.delete({ where: { id: n.id } });
  });

  it("the @@unique([notificationId, channel]) constraint rejects a duplicate raw insert", async () => {
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    await prisma.notificationDelivery.create({
      data: { notificationId: n.id, channel: "EMAIL", status: "SENT" },
    });

    await expect(
      prisma.notificationDelivery.create({ data: { notificationId: n.id, channel: "EMAIL", status: "SENT" } }),
    ).rejects.toThrow();

    await prisma.notification.delete({ where: { id: n.id } });
  });

  it("successful mocked provider -> SENT + deliveredAt + attemptCount = 1", async () => {
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });

    const summary = await deliverNotificationEmails([n.id], { sendEmail: okSend });

    expect(summary).toEqual({ attempted: 1, sent: 1, failed: 0, skipped: 0 });
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: n.id, channel: "EMAIL" } },
    });
    expect(delivery.status).toBe("SENT");
    expect(delivery.deliveredAt).not.toBeNull();
    expect(delivery.attemptCount).toBe(1);
    expect(delivery.failureCode).toBeNull();

    await prisma.notification.delete({ where: { id: n.id } });
  });

  it("provider failure -> FAILED, and the Notification row is untouched", async () => {
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });

    const summary = await deliverNotificationEmails([n.id], { sendEmail: failSend });

    expect(summary).toEqual({ attempted: 1, sent: 0, failed: 1, skipped: 0 });
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: n.id, channel: "EMAIL" } },
    });
    expect(delivery.status).toBe("FAILED");
    expect(delivery.deliveredAt).toBeNull();
    expect(delivery.failureCode).toBe("provider_error");

    const stillThere = await prisma.notification.findUnique({ where: { id: n.id } });
    expect(stillThere).not.toBeNull();

    await prisma.notification.delete({ where: { id: n.id } });
  });

  it("provider not configured -> SKIPPED, no sendEmail call made", async () => {
    setFromEmail(undefined);
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    const spy = vi.fn(okSend);

    const summary = await deliverNotificationEmails([n.id], { sendEmail: spy });

    expect(summary).toEqual({ attempted: 1, sent: 0, failed: 0, skipped: 1 });
    expect(spy).not.toHaveBeenCalled();
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: n.id, channel: "EMAIL" } },
    });
    expect(delivery.status).toBe("SKIPPED");
    expect(delivery.failureCode).toBe("not_configured");

    await prisma.notification.delete({ where: { id: n.id } });
  });

  it("a non-allowlisted type -> SKIPPED with 'not_allowlisted', no sendEmail call", async () => {
    const invitation = await prisma.invitation.create({
      data: {
        organizationId: fixtures.orgA.id,
        email: testEmail("delivery-invite", TEST_EMAIL_DOMAIN, fixtures.runId),
        role: Role.MEMBER,
        token: randomUUID(),
        status: "PENDING",
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    const n = await prisma.notification.create({
      data: {
        organizationId: fixtures.orgA.id,
        recipientId: fixtures.owner.id,
        type: "INVITATION_ACCEPTED",
        entityType: "INVITATION",
        entityId: invitation.id,
        metadata: { actorName: "Jane", acceptedUserName: "Jane", email: "jane@test.local", role: "MEMBER" },
      },
    });
    const spy = vi.fn(okSend);

    const summary = await deliverNotificationEmails([n.id], { sendEmail: spy });

    expect(summary).toEqual({ attempted: 1, sent: 0, failed: 0, skipped: 1 });
    expect(spy).not.toHaveBeenCalled();
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: n.id, channel: "EMAIL" } },
    });
    expect(delivery.failureCode).toBe("not_allowlisted");

    await prisma.notification.delete({ where: { id: n.id } });
    await prisma.invitation.delete({ where: { id: invitation.id } });
  });

  it("a repeat call after SENT makes no second provider call and leaves the row untouched", async () => {
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    const spy = vi.fn(okSend);

    await deliverNotificationEmails([n.id], { sendEmail: spy });
    const firstDelivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: n.id, channel: "EMAIL" } },
    });

    const secondSummary = await deliverNotificationEmails([n.id], { sendEmail: spy });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(secondSummary).toEqual({ attempted: 0, sent: 0, failed: 0, skipped: 0 });
    const secondDelivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: n.id, channel: "EMAIL" } },
    });
    expect(secondDelivery.deliveredAt).toEqual(firstDelivery.deliveredAt);
    expect(secondDelivery.attemptCount).toBe(1);

    await prisma.notification.delete({ where: { id: n.id } });
  });

  it("retry semantics: deliverNotificationEmails itself has no backoff awareness, only a hard ceiling (Stage 8's MAX_ATTEMPTS=3) — repeated calls retry up to it, then stop", async () => {
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    const spy = vi.fn(failSend);

    await deliverNotificationEmails([n.id], { sendEmail: spy }); // attemptCount -> 1, FAILED
    await deliverNotificationEmails([n.id], { sendEmail: spy }); // attemptCount -> 2, FAILED
    await deliverNotificationEmails([n.id], { sendEmail: spy }); // attemptCount -> 3, FAILED (ceiling)
    const afterThird = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: n.id, channel: "EMAIL" } },
    });
    expect(afterThird.status).toBe("FAILED");
    expect(afterThird.attemptCount).toBe(3);
    expect(spy).toHaveBeenCalledTimes(3);

    // A 4th call is a pure no-op — the ceiling is reached.
    const fourthSummary = await deliverNotificationEmails([n.id], { sendEmail: spy });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(fourthSummary).toEqual({ attempted: 0, sent: 0, failed: 0, skipped: 0 });

    // Backoff timing (waiting between attempts) is the retry job's own
    // concern (src/lib/notifications/jobs/retry-notification-deliveries.ts),
    // exercised in test/integration/notifications/retry-job.test.ts — this
    // request-bound path only enforces the total-attempts ceiling.

    await prisma.notification.delete({ where: { id: n.id } });
  });

  it("deleting a Notification cascades its NotificationDelivery row", async () => {
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    await deliverNotificationEmails([n.id], { sendEmail: okSend });
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: n.id, channel: "EMAIL" } },
    });

    await prisma.notification.delete({ where: { id: n.id } });

    const goneDelivery = await prisma.notificationDelivery.findUnique({ where: { id: delivery.id } });
    expect(goneDelivery).toBeNull();
  });

  it("cross-recipient isolation: delivering for one recipient's notification never touches another's delivery row", async () => {
    const forMember = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    const forAdmin = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.admin.id });

    await deliverNotificationEmails([forMember.id], { sendEmail: okSend });

    const memberDelivery = await prisma.notificationDelivery.findUnique({
      where: { notificationId_channel: { notificationId: forMember.id, channel: "EMAIL" } },
    });
    const adminDelivery = await prisma.notificationDelivery.findUnique({
      where: { notificationId_channel: { notificationId: forAdmin.id, channel: "EMAIL" } },
    });
    expect(memberDelivery?.status).toBe("SENT");
    expect(adminDelivery).toBeNull();

    await prisma.notification.deleteMany({ where: { id: { in: [forMember.id, forAdmin.id] } } });
  });

  it("cross-org isolation: notifications from two different orgs get independent delivery rows", async () => {
    const inA = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.owner.id });
    const inB = await createNotification({ organizationId: fixtures.orgB.id, recipientId: fixtures.orgBOwner.id });

    await deliverNotificationEmails([inA.id, inB.id], { sendEmail: okSend });

    const [deliveryA, deliveryB] = await Promise.all([
      prisma.notificationDelivery.findUniqueOrThrow({
        where: { notificationId_channel: { notificationId: inA.id, channel: "EMAIL" } },
      }),
      prisma.notificationDelivery.findUniqueOrThrow({
        where: { notificationId_channel: { notificationId: inB.id, channel: "EMAIL" } },
      }),
    ]);
    expect(deliveryA.notificationId).toBe(inA.id);
    expect(deliveryB.notificationId).toBe(inB.id);

    await prisma.notification.deleteMany({ where: { id: { in: [inA.id, inB.id] } } });
  });

  it("failureCode never contains the recipient's email or the notification metadata", async () => {
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });

    await deliverNotificationEmails([n.id], { sendEmail: failSend });

    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: n.id, channel: "EMAIL" } },
    });
    expect(delivery.failureCode).toBe("provider_error");
    expect(delivery.failureCode).not.toContain("@");
    expect(delivery.failureCode).not.toContain(fixtures.member.email);
    expect(delivery.failureCode).not.toContain("actorName");

    await prisma.notification.delete({ where: { id: n.id } });
  });

  it("a provider failure during post-commit delivery never rolls back the business mutation, Activity, or Notification", async () => {
    const disposableUser = await prisma.user.create({
      data: { email: testEmail("email-delivery-atomic", TEST_EMAIL_DOMAIN, fixtures.runId), name: "Disposable Atomic" },
    });
    const disposableMembership = await prisma.membership.create({
      data: { userId: disposableUser.id, organizationId: fixtures.orgA.id, role: Role.MEMBER },
    });

    const notificationIds = await prisma.$transaction(async (tx) => {
      await tx.membership.update({ where: { id: disposableMembership.id }, data: { role: Role.ADMIN } });
      const activity = await createActivity(tx, {
        organizationId: fixtures.orgA.id,
        actorId: fixtures.owner.id,
        entityType: "MEMBERSHIP",
        entityId: disposableMembership.id,
        action: "ROLE_CHANGED",
        metadata: buildRoleChangedMetadata(disposableUser, "MEMBER", "ADMIN", fixtures.owner.name),
        notificationContext: { affectedUserId: disposableUser.id },
      });
      return activity.notificationIds;
    });

    // The transaction has already committed by this point — a failing
    // provider below must only ever affect the NotificationDelivery row.
    await deliverNotificationEmails(notificationIds, { sendEmail: failSend });

    const membershipAfter = await prisma.membership.findUniqueOrThrow({ where: { id: disposableMembership.id } });
    expect(membershipAfter.role).toBe(Role.ADMIN); // committed, not rolled back

    const activityRow = await prisma.activity.findFirstOrThrow({
      where: { entityId: disposableMembership.id, action: "ROLE_CHANGED" },
    });
    expect(activityRow).not.toBeNull();

    const notification = await prisma.notification.findFirstOrThrow({
      where: { id: { in: notificationIds } },
    });
    expect(notification).not.toBeNull();
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: notification.id, channel: "EMAIL" } },
    });
    expect(delivery.status).toBe("FAILED");

    await prisma.notificationDelivery.deleteMany({ where: { notificationId: notification.id } });
    await prisma.notification.deleteMany({ where: { id: { in: notificationIds } } });
    await prisma.activity.deleteMany({ where: { entityId: disposableMembership.id } });
    await prisma.membership.delete({ where: { id: disposableMembership.id } });
    await prisma.user.delete({ where: { id: disposableUser.id } });
  });
});
