import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { Role } from "@/generated/prisma/enums";
import type { SendEmailFn } from "@/lib/email/resend-client";
import { retryNotificationDeliveries, STALE_LOCK_MS } from "@/lib/notifications/jobs/retry-notification-deliveries";
import { updateNotificationPreference, resetNotificationPreferences } from "@/lib/notifications/preferences";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { testEmail } from "../../support/run-id";
import { TEST_EMAIL_DOMAIN } from "../../support/env";

const TEST_FROM_EMAIL = "Test <test@example.com>";
const ORIGINAL_FROM_EMAIL = process.env.INVITATION_FROM_EMAIL;
const NOW = new Date("2026-08-03T12:00:00.000Z");

const okSend: SendEmailFn = async () => ({ ok: true });
const failSend: SendEmailFn = async () => ({ ok: false, reason: "provider_error" });

async function createNotification(overrides: { organizationId: string; recipientId: string }) {
  return prisma.notification.create({
    data: {
      organizationId: overrides.organizationId,
      recipientId: overrides.recipientId,
      type: "ROLE_CHANGED",
      metadata: { actorName: "Jane Doe", from: "MEMBER", to: "ADMIN" },
    },
  });
}

async function createDelivery(
  notificationId: string,
  overrides: {
    status: "PENDING" | "FAILED" | "PROCESSING" | "SENT" | "SKIPPED";
    attemptCount?: number;
    nextAttemptAt?: Date | null;
    lockedAt?: Date | null;
  },
) {
  return prisma.notificationDelivery.create({
    data: {
      notificationId,
      channel: "EMAIL",
      status: overrides.status,
      attemptCount: overrides.attemptCount ?? 0,
      nextAttemptAt: overrides.nextAttemptAt ?? null,
      lockedAt: overrides.lockedAt ?? null,
    },
  });
}

describe("retryNotificationDeliveries — integration", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
    process.env.INVITATION_FROM_EMAIL = TEST_FROM_EMAIL;
  });

  afterEach(async () => {
    process.env.INVITATION_FROM_EMAIL = TEST_FROM_EMAIL;
    await resetNotificationPreferences(fixtures.member.id);
  });

  afterAll(async () => {
    process.env.INVITATION_FROM_EMAIL = ORIGINAL_FROM_EMAIL;
    await cleanupTestData(fixtures);
  });

  it("claims a PENDING delivery and sends it -> SENT", async () => {
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    await createDelivery(n.id, { status: "PENDING", attemptCount: 0 });

    const summary = await retryNotificationDeliveries({ now: NOW, limit: 10, sendEmail: okSend });

    expect(summary).toEqual({ scanned: 1, claimed: 1, sent: 1, failed: 0, skipped: 0, deleted: 0 });
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: n.id, channel: "EMAIL" } },
    });
    expect(delivery.status).toBe("SENT");
    expect(delivery.attemptCount).toBe(1);

    await prisma.notification.delete({ where: { id: n.id } });
  });

  it("retries a FAILED delivery once its nextAttemptAt has passed", async () => {
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    await createDelivery(n.id, {
      status: "FAILED",
      attemptCount: 1,
      nextAttemptAt: new Date(NOW.getTime() - 1000),
    });

    const summary = await retryNotificationDeliveries({ now: NOW, limit: 10, sendEmail: okSend });

    expect(summary.claimed).toBe(1);
    expect(summary.sent).toBe(1);
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: n.id, channel: "EMAIL" } },
    });
    expect(delivery.status).toBe("SENT");
    expect(delivery.attemptCount).toBe(2);

    await prisma.notification.delete({ where: { id: n.id } });
  });

  it("does NOT retry a FAILED delivery before its nextAttemptAt", async () => {
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    await createDelivery(n.id, {
      status: "FAILED",
      attemptCount: 1,
      nextAttemptAt: new Date(NOW.getTime() + 1000),
    });
    const spy = vi.fn(okSend);

    const summary = await retryNotificationDeliveries({ now: NOW, limit: 10, sendEmail: spy });

    expect(summary).toEqual({ scanned: 0, claimed: 0, sent: 0, failed: 0, skipped: 0, deleted: 0 });
    expect(spy).not.toHaveBeenCalled();
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: n.id, channel: "EMAIL" } },
    });
    expect(delivery.status).toBe("FAILED");
    expect(delivery.attemptCount).toBe(1);

    await prisma.notification.delete({ where: { id: n.id } });
  });

  it("a FAILED delivery at the MAX_ATTEMPTS ceiling is never claimed again", async () => {
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    await createDelivery(n.id, { status: "FAILED", attemptCount: 3, nextAttemptAt: null });
    const spy = vi.fn(okSend);

    const summary = await retryNotificationDeliveries({ now: NOW, limit: 10, sendEmail: spy });

    expect(summary).toEqual({ scanned: 0, claimed: 0, sent: 0, failed: 0, skipped: 0, deleted: 0 });
    expect(spy).not.toHaveBeenCalled();

    await prisma.notification.delete({ where: { id: n.id } });
  });

  it("SENT and SKIPPED rows are never re-claimed", async () => {
    const sentNotification = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
    });
    const skippedNotification = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
    });
    await createDelivery(sentNotification.id, { status: "SENT", attemptCount: 1 });
    await createDelivery(skippedNotification.id, { status: "SKIPPED", attemptCount: 0 });
    const spy = vi.fn(okSend);

    const summary = await retryNotificationDeliveries({ now: NOW, limit: 10, sendEmail: spy });

    expect(summary.claimed).toBe(0);
    expect(spy).not.toHaveBeenCalled();

    await prisma.notification.deleteMany({ where: { id: { in: [sentNotification.id, skippedNotification.id] } } });
  });

  it("a preference disabled after the original attempt but before retry -> SKIPPED, no send call", async () => {
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    await createDelivery(n.id, { status: "PENDING", attemptCount: 0 });
    await updateNotificationPreference(fixtures.member.id, "ROLE_CHANGED", { emailEnabled: false });
    const spy = vi.fn(okSend);

    const summary = await retryNotificationDeliveries({ now: NOW, limit: 10, sendEmail: spy });

    expect(summary.skipped).toBe(1);
    expect(spy).not.toHaveBeenCalled();
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: n.id, channel: "EMAIL" } },
    });
    expect(delivery.status).toBe("SKIPPED");
    expect(delivery.failureCode).toBe("disabled_by_preference");

    await prisma.notification.delete({ where: { id: n.id } });
  });

  it("a recipient deleted before retry cascades away the Notification/Delivery — the job sees nothing and never errors", async () => {
    const disposableUser = await prisma.user.create({
      data: { email: testEmail("retry-job-deleted-recipient", TEST_EMAIL_DOMAIN, fixtures.runId), name: "Disposable" },
    });
    await prisma.membership.create({
      data: { userId: disposableUser.id, organizationId: fixtures.orgA.id, role: Role.MEMBER },
    });
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: disposableUser.id });
    await createDelivery(n.id, { status: "PENDING", attemptCount: 0 });

    await prisma.user.delete({ where: { id: disposableUser.id } });

    const goneNotification = await prisma.notification.findUnique({ where: { id: n.id } });
    expect(goneNotification).toBeNull();

    await expect(retryNotificationDeliveries({ now: NOW, limit: 10, sendEmail: okSend })).resolves.toBeDefined();
  });

  it("two concurrent job runs claiming the same PENDING row never both send it", async () => {
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    await createDelivery(n.id, { status: "PENDING", attemptCount: 0 });
    const spy = vi.fn(okSend);

    // Each concurrent invocation gets its OWN `now` (as every real cron
    // trigger would, via its own `new Date()`) — the claim mechanism's
    // "did *I* win" re-query matches on `lockedAt = this call's own now`,
    // so two calls sharing one identical `now` value would defeat the
    // very check being tested here (see retry-notification-deliveries.ts's
    // own docs on why `now` being unique per invocation is load-bearing).
    const nowA = NOW;
    const nowB = new Date(NOW.getTime() + 1);

    const [a, b] = await Promise.all([
      retryNotificationDeliveries({ now: nowA, limit: 10, sendEmail: spy }),
      retryNotificationDeliveries({ now: nowB, limit: 10, sendEmail: spy }),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(a.sent + b.sent).toBe(1);
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: n.id, channel: "EMAIL" } },
    });
    expect(delivery.status).toBe("SENT");
    expect(delivery.attemptCount).toBe(1);

    await prisma.notification.delete({ where: { id: n.id } });
  });

  it("a stale PROCESSING row (older than the stale-lock threshold) is reclaimed and retried", async () => {
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    const staleLockedAt = new Date(NOW.getTime() - STALE_LOCK_MS - 60_000);
    await createDelivery(n.id, { status: "PROCESSING", attemptCount: 1, lockedAt: staleLockedAt });

    const summary = await retryNotificationDeliveries({ now: NOW, limit: 10, sendEmail: okSend });

    expect(summary.claimed).toBe(1);
    expect(summary.sent).toBe(1);
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: n.id, channel: "EMAIL" } },
    });
    expect(delivery.status).toBe("SENT");

    await prisma.notification.delete({ where: { id: n.id } });
  });

  it("a fresh PROCESSING row (locked moments ago) is NOT reclaimed by a concurrent run", async () => {
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    const freshLockedAt = new Date(NOW.getTime() - 1000);
    await createDelivery(n.id, { status: "PROCESSING", attemptCount: 1, lockedAt: freshLockedAt });
    const spy = vi.fn(okSend);

    const summary = await retryNotificationDeliveries({ now: NOW, limit: 10, sendEmail: spy });

    expect(summary.claimed).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: n.id, channel: "EMAIL" } },
    });
    expect(delivery.status).toBe("PROCESSING");

    await prisma.notification.delete({ where: { id: n.id } });
  });

  it("one claimed delivery's provider failure doesn't stop the rest of the batch from being processed", async () => {
    const failing = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    const succeeding = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.admin.id });
    await createDelivery(failing.id, { status: "PENDING", attemptCount: 0 });
    await createDelivery(succeeding.id, { status: "PENDING", attemptCount: 0 });

    const mixedSend: SendEmailFn = async (params) => {
      if (params.to === fixtures.member.email) return { ok: false, reason: "provider_error" };
      return { ok: true };
    };

    const summary = await retryNotificationDeliveries({ now: NOW, limit: 10, sendEmail: mixedSend });

    expect(summary.claimed).toBe(2);
    expect(summary.sent).toBe(1);
    expect(summary.failed).toBe(1);

    const [failedDelivery, sentDelivery] = await Promise.all([
      prisma.notificationDelivery.findUniqueOrThrow({
        where: { notificationId_channel: { notificationId: failing.id, channel: "EMAIL" } },
      }),
      prisma.notificationDelivery.findUniqueOrThrow({
        where: { notificationId_channel: { notificationId: succeeding.id, channel: "EMAIL" } },
      }),
    ]);
    expect(failedDelivery.status).toBe("FAILED");
    expect(sentDelivery.status).toBe("SENT");

    await prisma.notification.deleteMany({ where: { id: { in: [failing.id, succeeding.id] } } });
  });

  it("the job's own response summary never carries an email address, notification id, delivery id, or provider error text — only aggregate counts", async () => {
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    await createDelivery(n.id, { status: "PENDING", attemptCount: 0 });

    const summary = await retryNotificationDeliveries({ now: NOW, limit: 10, sendEmail: failSend });

    expect(Object.keys(summary).sort()).toEqual(["claimed", "deleted", "failed", "scanned", "sent", "skipped"]);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("@");
    expect(serialized).not.toContain(n.id);
    expect(serialized).not.toContain("provider_error");

    await prisma.notification.delete({ where: { id: n.id } });
  });
});
