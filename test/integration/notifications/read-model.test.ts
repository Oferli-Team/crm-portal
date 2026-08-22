import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { Role } from "@/generated/prisma/enums";
import { markAllNotificationsReadAction, markNotificationReadAction } from "@/app/(dashboard)/actions";
import { getRecentNotifications, getUnreadNotificationCount } from "@/lib/notifications/queries";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { testEmail } from "../../support/run-id";
import { TEST_EMAIL_DOMAIN } from "../../support/env";

async function createNotification(overrides: {
  organizationId: string;
  recipientId: string;
  type?: "ROLE_CHANGED";
  readAt?: Date | null;
  createdAt?: Date;
}) {
  return prisma.notification.create({
    data: {
      organizationId: overrides.organizationId,
      recipientId: overrides.recipientId,
      type: overrides.type ?? "ROLE_CHANGED",
      metadata: { actorName: "Jane Doe", from: "MEMBER", to: "ADMIN" },
      readAt: overrides.readAt ?? null,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
}

describe("notification read model — queries + mark-as-read actions", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(() => {
    resetAuthMock();
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("getUnreadNotificationCount is scoped by recipient AND organization together", async () => {
    const n1 = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    const n2 = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    // Same recipient, different org — must not count toward orgA's total.
    const foreignOrgNotification = await createNotification({
      organizationId: fixtures.orgB.id,
      recipientId: fixtures.member.id,
    });
    // Same org, different recipient — must not count toward member's total.
    const foreignRecipientNotification = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.owner.id,
    });

    const count = await getUnreadNotificationCount({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
    });
    expect(count).toBe(2);

    await prisma.notification.deleteMany({
      where: { id: { in: [n1.id, n2.id, foreignOrgNotification.id, foreignRecipientNotification.id] } },
    });
  });

  it("getRecentNotifications orders by createdAt desc, id desc, and ties break deterministically", async () => {
    const sameInstant = new Date("2026-01-01T00:00:00.000Z");
    const older = new Date("2025-01-01T00:00:00.000Z");

    const a = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.admin.id,
      createdAt: sameInstant,
    });
    const b = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.admin.id,
      createdAt: sameInstant,
    });
    const c = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.admin.id,
      createdAt: older,
    });

    const rows = await getRecentNotifications({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.admin.id,
      limit: 10,
    });
    const ids = rows.map((r) => r.id);

    // Both `a` and `b` share createdAt — the tie-break is id desc, so
    // whichever id sorts higher comes first, and `c` (older) is always last.
    const expectedTieOrder = [a.id, b.id].sort().reverse();
    expect(ids.slice(0, 2)).toEqual(expectedTieOrder);
    expect(ids[2]).toBe(c.id);

    await prisma.notification.deleteMany({ where: { id: { in: [a.id, b.id, c.id] } } });
  });

  it("getRecentNotifications respects the limit", async () => {
    const rows = await Promise.all(
      Array.from({ length: 5 }, () =>
        createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.admin.id }),
      ),
    );

    const recent = await getRecentNotifications({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.admin.id,
      limit: 3,
    });
    expect(recent).toHaveLength(3);

    await prisma.notification.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  });

  it("markNotificationReadAction marks exactly the target row read, for its own recipient/org", async () => {
    const notification = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
    });
    actAs(fixtures.member, fixtures.orgA.id);

    await markNotificationReadAction(notification.id);

    const updated = await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } });
    expect(updated.readAt).not.toBeNull();

    await prisma.notification.delete({ where: { id: notification.id } });
  });

  it("marking an already-read notification again is idempotent (readAt doesn't change)", async () => {
    const readAt = new Date("2026-02-01T00:00:00.000Z");
    const notification = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
      readAt,
    });
    actAs(fixtures.member, fixtures.orgA.id);

    await markNotificationReadAction(notification.id);

    const updated = await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } });
    expect(updated.readAt).toEqual(readAt);

    await prisma.notification.delete({ where: { id: notification.id } });
  });

  it("a different user cannot mark someone else's notification as read", async () => {
    const notification = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
    });
    // owner tries to mark member's notification.
    actAs(fixtures.owner, fixtures.orgA.id);

    await markNotificationReadAction(notification.id);

    const unchanged = await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } });
    expect(unchanged.readAt).toBeNull();

    await prisma.notification.delete({ where: { id: notification.id } });
  });

  it("a notification from a foreign org cannot be marked read from the wrong active org, even for the same recipient", async () => {
    // Isolating "wrong org" from "wrong recipient" requires one person who
    // is a genuine member of both orgs — otherwise resolveActiveOrganizationId
    // would just silently fall back to their real org instead of exercising
    // the mismatch this test needs.
    const dualOrgUser = await prisma.user.create({
      data: { email: testEmail("cross-org-notif", TEST_EMAIL_DOMAIN, fixtures.runId), name: "Cross Org" },
    });
    await prisma.membership.createMany({
      data: [
        { userId: dualOrgUser.id, organizationId: fixtures.orgA.id, role: Role.MEMBER },
        { userId: dualOrgUser.id, organizationId: fixtures.orgB.id, role: Role.MEMBER },
      ],
    });
    const notification = await createNotification({
      organizationId: fixtures.orgB.id,
      recipientId: dualOrgUser.id,
    });
    actAs(dualOrgUser, fixtures.orgA.id);

    await markNotificationReadAction(notification.id);

    const unchanged = await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } });
    expect(unchanged.readAt).toBeNull();

    await prisma.notification.delete({ where: { id: notification.id } });
    await prisma.membership.deleteMany({ where: { userId: dualOrgUser.id } });
    await prisma.user.delete({ where: { id: dualOrgUser.id } });
  });

  it("markAllNotificationsReadAction affects only the current recipient + current org, leaving others untouched", async () => {
    const target1 = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.admin.id });
    const target2 = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.admin.id });
    const alreadyRead = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.admin.id,
      readAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const otherRecipient = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
    });
    const otherOrg = await createNotification({ organizationId: fixtures.orgB.id, recipientId: fixtures.admin.id });

    actAs(fixtures.admin, fixtures.orgA.id);
    await markAllNotificationsReadAction();

    const [t1, t2, already, otherRec, otherO] = await Promise.all([
      prisma.notification.findUniqueOrThrow({ where: { id: target1.id } }),
      prisma.notification.findUniqueOrThrow({ where: { id: target2.id } }),
      prisma.notification.findUniqueOrThrow({ where: { id: alreadyRead.id } }),
      prisma.notification.findUniqueOrThrow({ where: { id: otherRecipient.id } }),
      prisma.notification.findUniqueOrThrow({ where: { id: otherOrg.id } }),
    ]);

    expect(t1.readAt).not.toBeNull();
    expect(t2.readAt).not.toBeNull();
    expect(already.readAt).toEqual(new Date("2026-01-01T00:00:00.000Z")); // untouched, not rewritten
    expect(otherRec.readAt).toBeNull(); // different recipient, untouched
    expect(otherO.readAt).toBeNull(); // different org, untouched

    await prisma.notification.deleteMany({
      where: { id: { in: [target1.id, target2.id, alreadyRead.id, otherRecipient.id, otherOrg.id] } },
    });
  });

  it("org switch isolation: the same user sees a different notification set per active org", async () => {
    const dualOrgUser = await prisma.user.create({
      data: { email: testEmail("dual-org-notif", TEST_EMAIL_DOMAIN, fixtures.runId), name: "Dual Org" },
    });
    await prisma.membership.createMany({
      data: [
        { userId: dualOrgUser.id, organizationId: fixtures.orgA.id, role: Role.MEMBER },
        { userId: dualOrgUser.id, organizationId: fixtures.orgB.id, role: Role.MEMBER },
      ],
    });
    const inOrgA = await createNotification({ organizationId: fixtures.orgA.id, recipientId: dualOrgUser.id });
    const inOrgB = await createNotification({ organizationId: fixtures.orgB.id, recipientId: dualOrgUser.id });

    const countInA = await getUnreadNotificationCount({
      organizationId: fixtures.orgA.id,
      recipientId: dualOrgUser.id,
    });
    const countInB = await getUnreadNotificationCount({
      organizationId: fixtures.orgB.id,
      recipientId: dualOrgUser.id,
    });
    expect(countInA).toBe(1);
    expect(countInB).toBe(1);

    // Acting in orgA and marking all read must never touch orgB's row for
    // this same person — this is exactly what happens across an org switch.
    actAs(dualOrgUser, fixtures.orgA.id);
    await markAllNotificationsReadAction();

    const afterA = await prisma.notification.findUniqueOrThrow({ where: { id: inOrgA.id } });
    const stillUnreadInB = await prisma.notification.findUniqueOrThrow({ where: { id: inOrgB.id } });
    expect(afterA.readAt).not.toBeNull();
    expect(stillUnreadInB.readAt).toBeNull();

    await prisma.notification.deleteMany({ where: { id: { in: [inOrgA.id, inOrgB.id] } } });
    await prisma.membership.deleteMany({ where: { userId: dualOrgUser.id } });
    await prisma.user.delete({ where: { id: dualOrgUser.id } });
  });
});
