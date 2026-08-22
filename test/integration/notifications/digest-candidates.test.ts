import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { updateNotificationPreference, resetNotificationPreferences } from "@/lib/notifications/preferences";
import {
  getNotificationDigestCandidates,
  buildNotificationDigestModel,
} from "@/lib/notifications/jobs/digest-candidates";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";

async function createNotification(overrides: {
  organizationId: string;
  recipientId: string;
  type?: "ROLE_CHANGED" | "OWNERSHIP_TRANSFERRED";
  createdAt?: Date;
  readAt?: Date | null;
}) {
  return prisma.notification.create({
    data: {
      organizationId: overrides.organizationId,
      recipientId: overrides.recipientId,
      type: overrides.type ?? "ROLE_CHANGED",
      metadata: { actorName: "Jane Doe", from: "MEMBER", to: "ADMIN" },
      createdAt: overrides.createdAt ?? new Date("2026-08-01T00:00:00.000Z"),
      readAt: overrides.readAt ?? null,
    },
  });
}

describe("getNotificationDigestCandidates — integration", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(async () => {
    await resetNotificationPreferences(fixtures.member.id);
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("returns only notifications for the given recipient AND organization", async () => {
    const inRange = new Date("2026-08-01T12:00:00.000Z");
    const forMember = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
      createdAt: inRange,
    });
    const forAdmin = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.admin.id,
      createdAt: inRange,
    });

    const candidates = await getNotificationDigestCandidates({
      recipientId: fixtures.member.id,
      organizationId: fixtures.orgA.id,
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-08-02T00:00:00.000Z"),
    });

    expect(candidates.map((c) => c.id)).toEqual([forMember.id]);

    await prisma.notification.deleteMany({ where: { id: { in: [forMember.id, forAdmin.id] } } });
  });

  it("cross-org data never enters another organization's digest candidates", async () => {
    const inRange = new Date("2026-08-01T12:00:00.000Z");
    const inA = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.owner.id,
      createdAt: inRange,
    });
    const inB = await createNotification({
      organizationId: fixtures.orgB.id,
      recipientId: fixtures.orgBOwner.id,
      createdAt: inRange,
    });

    const candidatesForA = await getNotificationDigestCandidates({
      recipientId: fixtures.owner.id,
      organizationId: fixtures.orgA.id,
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-08-02T00:00:00.000Z"),
    });

    expect(candidatesForA.map((c) => c.id)).toEqual([inA.id]);
    expect(candidatesForA.map((c) => c.id)).not.toContain(inB.id);

    await prisma.notification.deleteMany({ where: { id: { in: [inA.id, inB.id] } } });
  });

  it("only includes notifications inside the [from, to) range", async () => {
    const before = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
      createdAt: new Date("2026-07-31T23:59:59.000Z"),
    });
    const inside = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    const after = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
    });

    const candidates = await getNotificationDigestCandidates({
      recipientId: fixtures.member.id,
      organizationId: fixtures.orgA.id,
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-08-02T00:00:00.000Z"),
    });

    expect(candidates.map((c) => c.id)).toEqual([inside.id]);

    await prisma.notification.deleteMany({ where: { id: { in: [before.id, inside.id, after.id] } } });
  });

  it("excludes types the recipient has disabled for email — a digest is an email-channel concept", async () => {
    const inRange = new Date("2026-08-01T12:00:00.000Z");
    await updateNotificationPreference(fixtures.member.id, "ROLE_CHANGED", { emailEnabled: false });
    const disabled = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
      type: "ROLE_CHANGED",
      createdAt: inRange,
    });
    const enabled = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
      type: "OWNERSHIP_TRANSFERRED",
      createdAt: inRange,
    });

    const candidates = await getNotificationDigestCandidates({
      recipientId: fixtures.member.id,
      organizationId: fixtures.orgA.id,
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-08-02T00:00:00.000Z"),
    });

    expect(candidates.map((c) => c.id)).toEqual([enabled.id]);

    await prisma.notification.deleteMany({ where: { id: { in: [disabled.id, enabled.id] } } });
  });

  it("never mutates readAt — the digest never marks anything read", async () => {
    const n = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
      createdAt: new Date("2026-08-01T12:00:00.000Z"),
      readAt: null,
    });

    const candidates = await getNotificationDigestCandidates({
      recipientId: fixtures.member.id,
      organizationId: fixtures.orgA.id,
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-08-02T00:00:00.000Z"),
    });
    buildNotificationDigestModel(candidates);

    const stillUnread = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(stillUnread.readAt).toBeNull();

    await prisma.notification.delete({ where: { id: n.id } });
  });

  it("never creates a NotificationDelivery row — the digest is read-only", async () => {
    const n = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
      createdAt: new Date("2026-08-01T12:00:00.000Z"),
    });

    const candidates = await getNotificationDigestCandidates({
      recipientId: fixtures.member.id,
      organizationId: fixtures.orgA.id,
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-08-02T00:00:00.000Z"),
    });
    buildNotificationDigestModel(candidates);

    const delivery = await prisma.notificationDelivery.findUnique({
      where: { notificationId_channel: { notificationId: n.id, channel: "EMAIL" } },
    });
    expect(delivery).toBeNull();

    await prisma.notification.delete({ where: { id: n.id } });
  });
});
