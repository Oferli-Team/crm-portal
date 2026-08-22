import { prisma } from "@/lib/prisma";
import type { NotificationPreference } from "@/generated/prisma/client";
import type { NotificationType } from "@/generated/prisma/enums";

// Single source of truth for "every NotificationType that can have a
// preference row" — the settings table (§7 UI) iterates this, and
// getDisabledInAppTypes below needs the full set to know which types have
// no row at all (and are therefore enabled by default).
export const NOTIFICATION_TYPES = [
  "ROLE_CHANGED",
  "OWNERSHIP_TRANSFERRED",
  "MEMBER_REMOVED",
  "INVITATION_ACCEPTED",
  "PORTAL_INVITATION_ACCEPTED",
  "INVOICE_STATUS_CHANGED",
  // Comments & Mentions Stage 3: added here (not in Stage 2's schema-only
  // change) because this array is what actually makes in-app/email
  // preference enforcement work for a type — getDisabledInAppTypes/
  // getDisabledEmailTypes below both iterate it, and the settings page
  // (already shipped in Stage 7) iterates it too, so a real row for this
  // type now becomes visible/toggleable there as an unavoidable, correct
  // consequence of preferences genuinely applying to MENTIONED — not new
  // UI work of this stage's own.
  "MENTIONED",
  // Billing & Subscriptions Stage 4 (docs/billing-architecture.md §17) —
  // real fan-out now exists (src/lib/billing/notify.ts, wired into the
  // webhook handler), so these belong here from day one, unlike MENTIONED's
  // own schema-first staged rollout above.
  "SUBSCRIPTION_ACTIVATED",
  "PAYMENT_FAILED",
  "SUBSCRIPTION_CANCELED",
  "PLAN_CHANGED",
] as const satisfies readonly NotificationType[];

export type NotificationPreferenceValue = {
  inAppEnabled: boolean;
  emailEnabled: boolean;
};

// The built-in default this whole feature is designed around: no row means
// both channels stay on. Never persisted proactively — see updateNotifica-
// tionPreference and resetNotificationPreferences below.
export const DEFAULT_NOTIFICATION_PREFERENCE: NotificationPreferenceValue = {
  inAppEnabled: true,
  emailEnabled: true,
};

export type NotificationPreferenceMap = Record<NotificationType, NotificationPreferenceValue>;

/** Raw rows only — a user who never touched settings has zero rows here, not one per type. */
export async function getNotificationPreferences(userId: string): Promise<NotificationPreference[]> {
  return prisma.notificationPreference.findMany({ where: { userId } });
}

/**
 * Pure — no I/O. Every NotificationType is always present in the returned
 * map; missing rows are filled in with DEFAULT_NOTIFICATION_PREFERENCE so
 * callers (the settings UI, the query-layer filter below) never have to
 * special-case "no row yet" themselves. Separated from
 * getNotificationPreferenceMap below so this fill-in logic is unit-
 * testable without a database.
 */
export function buildNotificationPreferenceMap(
  rows: Pick<NotificationPreference, "type" | "inAppEnabled" | "emailEnabled">[],
): NotificationPreferenceMap {
  const byType = new Map(rows.map((row) => [row.type, row]));

  const map = {} as NotificationPreferenceMap;
  for (const type of NOTIFICATION_TYPES) {
    const row = byType.get(type);
    map[type] = row
      ? { inAppEnabled: row.inAppEnabled, emailEnabled: row.emailEnabled }
      : { ...DEFAULT_NOTIFICATION_PREFERENCE };
  }
  return map;
}

export async function getNotificationPreferenceMap(userId: string): Promise<NotificationPreferenceMap> {
  const rows = await getNotificationPreferences(userId);
  return buildNotificationPreferenceMap(rows);
}

/**
 * Lazily creates the row on first change (upsert), and only ever writes
 * the field(s) actually being changed — a user toggling just the email
 * column never touches inAppEnabled's stored value. Scoped by userId in
 * the WHERE via the @@unique([userId, type]) compound key; callers must
 * always pass a server-resolved userId, never one read from client input.
 */
export async function updateNotificationPreference(
  userId: string,
  type: NotificationType,
  values: Partial<NotificationPreferenceValue>,
): Promise<void> {
  await prisma.notificationPreference.upsert({
    where: { userId_type: { userId, type } },
    create: {
      userId,
      type,
      inAppEnabled: values.inAppEnabled ?? DEFAULT_NOTIFICATION_PREFERENCE.inAppEnabled,
      emailEnabled: values.emailEnabled ?? DEFAULT_NOTIFICATION_PREFERENCE.emailEnabled,
    },
    update: values,
  });
}

/**
 * "Reset to defaults" deletes every row for this user rather than writing
 * {inAppEnabled: true, emailEnabled: true} back — a reset user and a user
 * who never touched settings must be indistinguishable in this table (see
 * the model's own doc comment in schema.prisma).
 */
export async function resetNotificationPreferences(userId: string): Promise<void> {
  await prisma.notificationPreference.deleteMany({ where: { userId } });
}

/** No row (undefined/null) means "on" — the same default the DB column itself declares. */
export function shouldDeliverInApp(preference: NotificationPreferenceValue | null | undefined): boolean {
  return preference?.inAppEnabled ?? DEFAULT_NOTIFICATION_PREFERENCE.inAppEnabled;
}

/** No row (undefined/null) means "on" — the same default the DB column itself declares. */
export function shouldDeliverEmail(preference: NotificationPreferenceValue | null | undefined): boolean {
  return preference?.emailEnabled ?? DEFAULT_NOTIFICATION_PREFERENCE.emailEnabled;
}

/**
 * The read-model query layer's one hook into preferences: which types this
 * recipient has explicitly turned in-app notifications off for. Almost
 * always empty (most users never touch settings) — deliberately a single,
 * small (at most 6 rows) query the caller fetches once and threads through
 * getUnreadNotificationCount/getRecentNotifications/getNotificationsPage,
 * rather than each of those re-querying preferences itself.
 */
export async function getDisabledInAppTypes(userId: string): Promise<NotificationType[]> {
  const map = await getNotificationPreferenceMap(userId);
  return NOTIFICATION_TYPES.filter((type) => !shouldDeliverInApp(map[type]));
}

/**
 * Same shape as getDisabledInAppTypes, for the email channel — used by the
 * digest foundation (src/lib/notifications/jobs/digest-candidates.ts),
 * since a digest is fundamentally an email-channel concept and should
 * respect the same per-type opt-out a direct notification email would.
 */
export async function getDisabledEmailTypes(userId: string): Promise<NotificationType[]> {
  const map = await getNotificationPreferenceMap(userId);
  return NOTIFICATION_TYPES.filter((type) => !shouldDeliverEmail(map[type]));
}
