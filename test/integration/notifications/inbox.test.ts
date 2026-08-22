import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { markAllNotificationsReadAction, markNotificationReadAction } from "@/app/(dashboard)/actions";
import { getNotificationsPage, getUnreadNotificationCount } from "@/lib/notifications/queries";
import { parseNotificationListParams, buildNotificationWhere } from "@/lib/notifications/list-params";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";

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
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
}

function pageFor(organizationId: string, recipientId: string, searchParams: Record<string, string>) {
  const listParams = parseNotificationListParams(searchParams);
  const where = buildNotificationWhere(organizationId, recipientId, listParams);
  return { listParams, where };
}

describe("/notifications inbox — query layer + mark-read wiring", () => {
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

  it("filter=all returns both read and unread rows", async () => {
    const unread1 = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.admin.id });
    const unread2 = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.admin.id });
    const read1 = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.admin.id,
      readAt: new Date(),
    });
    const read2 = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.admin.id,
      readAt: new Date(),
    });
    const ids = [unread1.id, unread2.id, read1.id, read2.id];

    const { where } = pageFor(fixtures.orgA.id, fixtures.admin.id, {});
    const { rows } = await getNotificationsPage(where);

    expect(rows.filter((r) => ids.includes(r.id))).toHaveLength(4);

    await prisma.notification.deleteMany({ where: { id: { in: ids } } });
  });

  it("filter=unread returns only unread rows", async () => {
    const unread = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.admin.id });
    const read = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.admin.id,
      readAt: new Date(),
    });

    const { where } = pageFor(fixtures.orgA.id, fixtures.admin.id, { filter: "unread" });
    const { rows } = await getNotificationsPage(where);
    const returnedIds = rows.map((r) => r.id);

    expect(returnedIds).toContain(unread.id);
    expect(returnedIds).not.toContain(read.id);

    await prisma.notification.deleteMany({ where: { id: { in: [unread.id, read.id] } } });
  });

  it("pagination: >25 rows paginate with no duplicates and no gaps", async () => {
    const base = new Date("2026-03-01T00:00:00.000Z");
    const created = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        createNotification({
          organizationId: fixtures.orgA.id,
          recipientId: fixtures.member.id,
          createdAt: new Date(base.getTime() + i * 1000),
        }),
      ),
    );
    const allIds = created.map((n) => n.id).sort();

    const page1 = await getNotificationsPage(pageFor(fixtures.orgA.id, fixtures.member.id, {}).where);
    expect(page1.rows).toHaveLength(25);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();

    const { where: where2 } = pageFor(fixtures.orgA.id, fixtures.member.id, { cursor: page1.nextCursor! });
    const page2 = await getNotificationsPage(where2);
    expect(page2.rows).toHaveLength(5);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();

    const combinedIds = [...page1.rows, ...page2.rows].map((r) => r.id).sort();
    expect(combinedIds).toEqual(allIds); // no duplicates, no gaps
    expect(new Set(combinedIds).size).toBe(30); // no duplicates, explicitly

    await prisma.notification.deleteMany({ where: { id: { in: allIds } } });
  });

  it("rows sharing the exact same createdAt tie-break by id desc, and pagination across the tie is stable", async () => {
    const sameInstant = new Date("2026-04-01T00:00:00.000Z");
    const tied = await Promise.all(
      Array.from({ length: 3 }, () =>
        createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id, createdAt: sameInstant }),
      ),
    );
    const expectedOrder = [...tied.map((n) => n.id)].sort().reverse();

    const { rows } = await getNotificationsPage(pageFor(fixtures.orgA.id, fixtures.member.id, {}).where);
    const tiedInOrder = rows.filter((r) => tied.some((t) => t.id === r.id)).map((r) => r.id);
    expect(tiedInOrder).toEqual(expectedOrder);

    await prisma.notification.deleteMany({ where: { id: { in: tied.map((n) => n.id) } } });
  });

  it("an invalid cursor degrades to the first page, not an error", async () => {
    const n1 = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.admin.id });

    const { listParams, where } = pageFor(fixtures.orgA.id, fixtures.admin.id, { cursor: "not-a-valid-cursor!!" });
    expect(listParams.cursorInvalid).toBe(true);

    const { rows } = await getNotificationsPage(where);
    expect(rows.map((r) => r.id)).toContain(n1.id);

    await prisma.notification.delete({ where: { id: n1.id } });
  });

  it("the filter survives across a paginated cursor: page 2 of 'unread' never leaks a read row", async () => {
    const base = new Date("2026-05-01T00:00:00.000Z");
    const unread = await Promise.all(
      Array.from({ length: 26 }, (_, i) =>
        createNotification({
          organizationId: fixtures.orgA.id,
          recipientId: fixtures.owner.id,
          createdAt: new Date(base.getTime() + i * 1000),
        }),
      ),
    );
    // Interleave a handful of already-read rows in the same window — must
    // never appear on either page of the unread-filtered pagination.
    const read = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        createNotification({
          organizationId: fixtures.orgA.id,
          recipientId: fixtures.owner.id,
          createdAt: new Date(base.getTime() + i * 1000 + 500),
          readAt: new Date(),
        }),
      ),
    );

    const page1 = await getNotificationsPage(pageFor(fixtures.orgA.id, fixtures.owner.id, { filter: "unread" }).where);
    expect(page1.rows).toHaveLength(25);
    expect(page1.hasMore).toBe(true);
    expect(page1.rows.some((r) => read.some((rd) => rd.id === r.id))).toBe(false);

    const page2 = await getNotificationsPage(
      pageFor(fixtures.orgA.id, fixtures.owner.id, { filter: "unread", cursor: page1.nextCursor! }).where,
    );
    expect(page2.rows).toHaveLength(1);
    expect(page2.rows.some((r) => read.some((rd) => rd.id === r.id))).toBe(false);

    const combined = [...page1.rows, ...page2.rows].map((r) => r.id).sort();
    expect(combined).toEqual(unread.map((n) => n.id).sort());

    await prisma.notification.deleteMany({ where: { id: { in: [...unread, ...read].map((n) => n.id) } } });
  });

  it("cross-user isolation: another recipient's notifications never appear on this page", async () => {
    const mine = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.admin.id });
    const someoneElses = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
    });

    const { rows } = await getNotificationsPage(pageFor(fixtures.orgA.id, fixtures.admin.id, {}).where);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(someoneElses.id);

    await prisma.notification.deleteMany({ where: { id: { in: [mine.id, someoneElses.id] } } });
  });

  it("cross-org isolation: the same recipient's notification in a different org never appears", async () => {
    const dualOrgUser = await prisma.user.create({
      data: { email: `inbox-dual-${fixtures.runId}@test.local`, name: "Inbox Dual Org" },
    });
    await prisma.membership.createMany({
      data: [
        { userId: dualOrgUser.id, organizationId: fixtures.orgA.id, role: "MEMBER" },
        { userId: dualOrgUser.id, organizationId: fixtures.orgB.id, role: "MEMBER" },
      ],
    });
    const inA = await createNotification({ organizationId: fixtures.orgA.id, recipientId: dualOrgUser.id });
    const inB = await createNotification({ organizationId: fixtures.orgB.id, recipientId: dualOrgUser.id });

    const { rows } = await getNotificationsPage(pageFor(fixtures.orgA.id, dualOrgUser.id, {}).where);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(inA.id);
    expect(ids).not.toContain(inB.id);

    await prisma.notification.deleteMany({ where: { id: { in: [inA.id, inB.id] } } });
    await prisma.membership.deleteMany({ where: { userId: dualOrgUser.id } });
    await prisma.user.delete({ where: { id: dualOrgUser.id } });
  });

  it("marking one notification read removes it from the unread-filtered page, and the unread count stays consistent", async () => {
    const a = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    const b = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    actAs(fixtures.member, fixtures.orgA.id);

    await markNotificationReadAction(a.id);

    const { rows } = await getNotificationsPage(pageFor(fixtures.orgA.id, fixtures.member.id, { filter: "unread" }).where);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(a.id);
    expect(ids).toContain(b.id);

    const unreadCount = await getUnreadNotificationCount({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
    });
    expect(unreadCount).toBe(ids.length);

    await prisma.notification.deleteMany({ where: { id: { in: [a.id, b.id] } } });
  });

  it("mark all clears the unread-filtered page to empty, while the all-filtered page still shows every row", async () => {
    const a = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.admin.id });
    const b = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.admin.id });
    actAs(fixtures.admin, fixtures.orgA.id);

    await markAllNotificationsReadAction();

    const unreadPage = await getNotificationsPage(
      pageFor(fixtures.orgA.id, fixtures.admin.id, { filter: "unread" }).where,
    );
    expect(unreadPage.rows.filter((r) => [a.id, b.id].includes(r.id))).toHaveLength(0);

    const allPage = await getNotificationsPage(pageFor(fixtures.orgA.id, fixtures.admin.id, {}).where);
    expect(allPage.rows.filter((r) => [a.id, b.id].includes(r.id))).toHaveLength(2);

    const unreadCount = await getUnreadNotificationCount({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.admin.id,
    });
    expect(unreadCount).toBe(0);

    await prisma.notification.deleteMany({ where: { id: { in: [a.id, b.id] } } });
  });
});
