import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import type { SendEmailFn } from "@/lib/email/resend-client";
import {
  getNotificationPreferences,
  getNotificationPreferenceMap,
  updateNotificationPreference,
  resetNotificationPreferences,
  getDisabledInAppTypes,
  DEFAULT_NOTIFICATION_PREFERENCE,
  NOTIFICATION_TYPES,
} from "@/lib/notifications/preferences";
import {
  updateNotificationPreferenceAction,
  resetNotificationPreferencesAction,
} from "@/app/(dashboard)/settings/actions";
import { getUnreadNotificationCount, getRecentNotifications, getNotificationsPage } from "@/lib/notifications/queries";
import { buildNotificationWhere, parseNotificationListParams } from "@/lib/notifications/list-params";
import { deliverNotificationEmails } from "@/lib/notifications/email/deliver-notification-email";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";

const TEST_FROM_EMAIL = "Test <test@example.com>";
const ORIGINAL_FROM_EMAIL = process.env.INVITATION_FROM_EMAIL;

async function createNotification(overrides: { organizationId: string; recipientId: string; type?: string }) {
  return prisma.notification.create({
    data: {
      organizationId: overrides.organizationId,
      recipientId: overrides.recipientId,
      type: (overrides.type as "ROLE_CHANGED") ?? "ROLE_CHANGED",
      metadata: { actorName: "Jane Doe", from: "MEMBER", to: "ADMIN" },
    },
  });
}

describe("notification preferences — integration", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
    process.env.INVITATION_FROM_EMAIL = TEST_FROM_EMAIL;
  });

  afterEach(() => {
    resetAuthMock();
    process.env.INVITATION_FROM_EMAIL = TEST_FROM_EMAIL;
  });

  afterAll(async () => {
    process.env.INVITATION_FROM_EMAIL = ORIGINAL_FROM_EMAIL;
    await cleanupTestData(fixtures);
  });

  it("default fallback: a user with zero rows gets the built-in default for every type", async () => {
    const map = await getNotificationPreferenceMap(fixtures.member.id);
    for (const type of NOTIFICATION_TYPES) {
      expect(map[type]).toEqual(DEFAULT_NOTIFICATION_PREFERENCE);
    }
    const rows = await getNotificationPreferences(fixtures.member.id);
    expect(rows).toHaveLength(0);
  });

  it("creates a preference row lazily on first update, defaulting the untouched field", async () => {
    await updateNotificationPreference(fixtures.admin.id, "ROLE_CHANGED", { inAppEnabled: false });

    const rows = await getNotificationPreferences(fixtures.admin.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("ROLE_CHANGED");
    expect(rows[0].inAppEnabled).toBe(false);
    expect(rows[0].emailEnabled).toBe(true); // defaulted, not left null

    await resetNotificationPreferences(fixtures.admin.id);
  });

  it("update only touches the specified field, leaving the other untouched", async () => {
    await updateNotificationPreference(fixtures.admin.id, "ROLE_CHANGED", { inAppEnabled: false });
    await updateNotificationPreference(fixtures.admin.id, "ROLE_CHANGED", { emailEnabled: false });

    const map = await getNotificationPreferenceMap(fixtures.admin.id);
    expect(map.ROLE_CHANGED).toEqual({ inAppEnabled: false, emailEnabled: false });
    // Untouched types still default.
    expect(map.MEMBER_REMOVED).toEqual(DEFAULT_NOTIFICATION_PREFERENCE);

    await resetNotificationPreferences(fixtures.admin.id);
  });

  it("reset deletes the rows rather than writing true/true back", async () => {
    await updateNotificationPreference(fixtures.admin.id, "ROLE_CHANGED", { inAppEnabled: false });
    await updateNotificationPreference(fixtures.admin.id, "MEMBER_REMOVED", { emailEnabled: false });
    expect(await getNotificationPreferences(fixtures.admin.id)).toHaveLength(2);

    await resetNotificationPreferences(fixtures.admin.id);

    const rows = await getNotificationPreferences(fixtures.admin.id);
    expect(rows).toHaveLength(0);
    const map = await getNotificationPreferenceMap(fixtures.admin.id);
    expect(map.ROLE_CHANGED).toEqual(DEFAULT_NOTIFICATION_PREFERENCE);
  });

  it("cross-user denial: the Server Action only ever touches the current user's own row", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    await updateNotificationPreferenceAction("ROLE_CHANGED", "email", false);

    const ownerMap = await getNotificationPreferenceMap(fixtures.owner.id);
    expect(ownerMap.ROLE_CHANGED.emailEnabled).toBe(false);

    // A different user, acting in their own session, is completely unaffected.
    const memberMap = await getNotificationPreferenceMap(fixtures.member.id);
    expect(memberMap.ROLE_CHANGED).toEqual(DEFAULT_NOTIFICATION_PREFERENCE);

    await resetNotificationPreferences(fixtures.owner.id);
  });

  it("cross-user denial: resetNotificationPreferencesAction only clears the acting user's own rows", async () => {
    await updateNotificationPreference(fixtures.owner.id, "ROLE_CHANGED", { inAppEnabled: false });
    await updateNotificationPreference(fixtures.member.id, "ROLE_CHANGED", { inAppEnabled: false });

    actAs(fixtures.owner, fixtures.orgA.id);
    await resetNotificationPreferencesAction();

    expect(await getNotificationPreferences(fixtures.owner.id)).toHaveLength(0);
    // member's own row survives — reset never cascades across users.
    const memberRows = await getNotificationPreferences(fixtures.member.id);
    expect(memberRows).toHaveLength(1);

    await resetNotificationPreferences(fixtures.member.id);
  });

  it("getDisabledInAppTypes reflects only the types explicitly turned off", async () => {
    await updateNotificationPreference(fixtures.admin.id, "ROLE_CHANGED", { inAppEnabled: false });
    await updateNotificationPreference(fixtures.admin.id, "MEMBER_REMOVED", { inAppEnabled: true }); // explicit true, still "enabled"

    const disabled = await getDisabledInAppTypes(fixtures.admin.id);
    expect(disabled).toEqual(["ROLE_CHANGED"]);

    await resetNotificationPreferences(fixtures.admin.id);
  });

  it("query filtering: a disabled type is excluded from unread count, recent list, and the paginated inbox", async () => {
    const enabled = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    const disabled = await createNotification({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
      type: "MEMBER_REMOVED",
    });
    await updateNotificationPreference(fixtures.member.id, "MEMBER_REMOVED", { inAppEnabled: false });

    const excludeTypes = await getDisabledInAppTypes(fixtures.member.id);
    expect(excludeTypes).toEqual(["MEMBER_REMOVED"]);

    const count = await getUnreadNotificationCount({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
      excludeTypes,
    });
    const recent = await getRecentNotifications({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
      limit: 10,
      excludeTypes,
    });
    const listParams = parseNotificationListParams({});
    const where = buildNotificationWhere(fixtures.orgA.id, fixtures.member.id, listParams, excludeTypes);
    const page = await getNotificationsPage(where);

    const recentIds = recent.map((n) => n.id);
    const pageIds = page.rows.map((n) => n.id);
    expect(recentIds).toContain(enabled.id);
    expect(recentIds).not.toContain(disabled.id);
    expect(pageIds).toContain(enabled.id);
    expect(pageIds).not.toContain(disabled.id);
    expect(count).toBe(1); // only the enabled-type notification counts as unread

    // Without excludeTypes, both still show up — filtering is opt-in per caller.
    const recentUnfiltered = await getRecentNotifications({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
      limit: 10,
    });
    expect(recentUnfiltered.map((n) => n.id)).toContain(disabled.id);

    await prisma.notification.deleteMany({ where: { id: { in: [enabled.id, disabled.id] } } });
    await resetNotificationPreferences(fixtures.member.id);
  });

  it("the Notification row still exists (and is readable directly) when in-app is disabled for its type", async () => {
    await updateNotificationPreference(fixtures.member.id, "ROLE_CHANGED", { inAppEnabled: false });
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });

    const excludeTypes = await getDisabledInAppTypes(fixtures.member.id);
    const recent = await getRecentNotifications({
      organizationId: fixtures.orgA.id,
      recipientId: fixtures.member.id,
      limit: 10,
      excludeTypes,
    });
    expect(recent.map((r) => r.id)).not.toContain(n.id);

    // Never deleted, never mutated — just filtered out at read time.
    const stillThere = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(stillThere.id).toBe(n.id);
    expect(stillThere.readAt).toBeNull();

    await prisma.notification.delete({ where: { id: n.id } });
    await resetNotificationPreferences(fixtures.member.id);
  });

  it("the email delivery helper respects a disabled email preference (SKIPPED, no provider call)", async () => {
    await updateNotificationPreference(fixtures.member.id, "ROLE_CHANGED", { emailEnabled: false });
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    const spy = vi.fn<SendEmailFn>(async () => ({ ok: true }));

    const summary = await deliverNotificationEmails([n.id], { sendEmail: spy });

    expect(summary).toEqual({ attempted: 1, sent: 0, failed: 0, skipped: 1 });
    expect(spy).not.toHaveBeenCalled();
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: n.id, channel: "EMAIL" } },
    });
    expect(delivery.status).toBe("SKIPPED");
    expect(delivery.failureCode).toBe("disabled_by_preference");

    await prisma.notification.delete({ where: { id: n.id } });
    await resetNotificationPreferences(fixtures.member.id);
  });

  it("the email delivery helper still sends when the preference is left at its default (enabled)", async () => {
    const n = await createNotification({ organizationId: fixtures.orgA.id, recipientId: fixtures.member.id });
    const spy = vi.fn<SendEmailFn>(async () => ({ ok: true }));

    const summary = await deliverNotificationEmails([n.id], { sendEmail: spy });

    expect(summary).toEqual({ attempted: 1, sent: 1, failed: 0, skipped: 0 });
    expect(spy).toHaveBeenCalledTimes(1);

    await prisma.notification.delete({ where: { id: n.id } });
  });
});
