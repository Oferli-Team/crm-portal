import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { cleanupNotifications, NOTIFICATION_RETENTION_MS } from "@/lib/notifications/jobs/cleanup-notifications";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";

const NOW = new Date("2026-08-03T12:00:00.000Z");

async function createNotification(overrides: {
  organizationId: string;
  recipientId: string;
  readAt?: Date | null;
  createdAt?: Date;
}) {
  return prisma.notification.create({
    data: {
      organizationId: overrides.organizationId,
      recipientId: overrides.recipientId,
      type: "ROLE_CHANGED",
      metadata: { actorName: "Jane Doe", from: "MEMBER", to: "ADMIN" },
      readAt: overrides.readAt ?? null,
      createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
    },
  });
}

describe("cleanupNotifications — integration", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("deletes a read Notification older than the retention window", async () => {
    const readAt = new Date(NOW.getTime() - NOTIFICATION_RETENTION_MS - 60_000);
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id, readAt });

    const summary = await cleanupNotifications({ now: NOW, batchSize: 500 });

    expect(summary.deleted).toBeGreaterThanOrEqual(1);
    const gone = await prisma.notification.findUnique({ where: { id: n.id } });
    expect(gone).toBeNull();
  });

  it("never deletes an unread Notification, regardless of age", async () => {
    const n = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
      readAt: null,
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    });

    await cleanupNotifications({ now: NOW, batchSize: 500 });

    const stillThere = await prisma.notification.findUnique({ where: { id: n.id } });
    expect(stillThere).not.toBeNull();

    await prisma.notification.delete({ where: { id: n.id } });
  });

  it("a read Notification younger than the retention window remains", async () => {
    const readAt = new Date(NOW.getTime() - 60_000);
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id, readAt });

    await cleanupNotifications({ now: NOW, batchSize: 500 });

    const stillThere = await prisma.notification.findUnique({ where: { id: n.id } });
    expect(stillThere).not.toBeNull();

    await prisma.notification.delete({ where: { id: n.id } });
  });

  it("a read Notification exactly at the retention boundary is NOT yet deleted", async () => {
    const readAt = new Date(NOW.getTime() - NOTIFICATION_RETENTION_MS);
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id, readAt });

    await cleanupNotifications({ now: NOW, batchSize: 500 });

    const stillThere = await prisma.notification.findUnique({ where: { id: n.id } });
    expect(stillThere).not.toBeNull();

    await prisma.notification.delete({ where: { id: n.id } });
  });

  it("respects the batchSize limit — only that many rows are deleted in one call, even when more are eligible", async () => {
    const readAt = new Date(NOW.getTime() - NOTIFICATION_RETENTION_MS - 60_000);
    const notifications = await Promise.all(
      Array.from({ length: 3 }, () =>
        createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id, readAt }),
      ),
    );

    const summary = await cleanupNotifications({ now: NOW, batchSize: 2 });

    expect(summary.deleted).toBe(2);
    const remaining = await prisma.notification.findMany({
      where: { id: { in: notifications.map((n) => n.id) } },
    });
    expect(remaining).toHaveLength(1);

    await prisma.notification.deleteMany({ where: { id: { in: remaining.map((n) => n.id) } } });
  });

  it("deleting a Notification cascades its NotificationDelivery row", async () => {
    const readAt = new Date(NOW.getTime() - NOTIFICATION_RETENTION_MS - 60_000);
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id, readAt });
    const delivery = await prisma.notificationDelivery.create({
      data: { notificationId: n.id, channel: "EMAIL", status: "SENT" },
    });

    await cleanupNotifications({ now: NOW, batchSize: 500 });

    const goneDelivery = await prisma.notificationDelivery.findUnique({ where: { id: delivery.id } });
    expect(goneDelivery).toBeNull();
  });

  it("cleaning up a Notification never removes the Activity it was generated from", async () => {
    const activity = await prisma.activity.create({
      data: {
        organizationId: fixtures.orgA.id,
        actorId: fixtures.owner.id,
        entityType: "CLIENT",
        entityId: fixtures.clientA.id,
        action: "CREATED",
        metadata: { name: "Cleanup Survives Test", status: "LEAD", actorName: fixtures.owner.name },
      },
    });
    const readAt = new Date(NOW.getTime() - NOTIFICATION_RETENTION_MS - 60_000);
    const n = await prisma.notification.create({
      data: {
        organizationId: fixtures.orgA.id,
        recipientId: fixtures.member.id,
        activityId: activity.id,
        type: "ROLE_CHANGED",
        metadata: { actorName: "Jane Doe", from: "MEMBER", to: "ADMIN" },
        readAt,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });

    await cleanupNotifications({ now: NOW, batchSize: 500 });

    const goneNotification = await prisma.notification.findUnique({ where: { id: n.id } });
    expect(goneNotification).toBeNull();
    const activityStillThere = await prisma.activity.findUnique({ where: { id: activity.id } });
    expect(activityStillThere).not.toBeNull();

    await prisma.activity.delete({ where: { id: activity.id } });
  });

  it("calling cleanup repeatedly with nothing eligible left is a clean no-op", async () => {
    const first = await cleanupNotifications({ now: NOW, batchSize: 500 });
    const second = await cleanupNotifications({ now: NOW, batchSize: 500 });
    expect(second.scanned).toBe(0);
    expect(second.deleted).toBe(0);
    void first;
  });
});
