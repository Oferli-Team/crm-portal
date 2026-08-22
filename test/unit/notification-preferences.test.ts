import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_TYPES,
  DEFAULT_NOTIFICATION_PREFERENCE,
  buildNotificationPreferenceMap,
  shouldDeliverInApp,
  shouldDeliverEmail,
} from "@/lib/notifications/preferences";

describe("NOTIFICATION_TYPES", () => {
  it("lists exactly the 11 approved NotificationType values", () => {
    expect([...NOTIFICATION_TYPES].sort()).toEqual(
      [
        "ROLE_CHANGED",
        "OWNERSHIP_TRANSFERRED",
        "MEMBER_REMOVED",
        "INVITATION_ACCEPTED",
        "PORTAL_INVITATION_ACCEPTED",
        "INVOICE_STATUS_CHANGED",
        "MENTIONED",
        "SUBSCRIPTION_ACTIVATED",
        "PAYMENT_FAILED",
        "SUBSCRIPTION_CANCELED",
        "PLAN_CHANGED",
      ].sort(),
    );
  });
});

describe("buildNotificationPreferenceMap — the pure map-builder", () => {
  it("no rows at all -> every type falls back to the default (both channels on)", () => {
    const map = buildNotificationPreferenceMap([]);
    for (const type of NOTIFICATION_TYPES) {
      expect(map[type]).toEqual(DEFAULT_NOTIFICATION_PREFERENCE);
    }
  });

  it("a row for one type overrides only that type, others still default", () => {
    const map = buildNotificationPreferenceMap([
      { type: "ROLE_CHANGED", inAppEnabled: false, emailEnabled: true },
    ]);
    expect(map.ROLE_CHANGED).toEqual({ inAppEnabled: false, emailEnabled: true });
    expect(map.OWNERSHIP_TRANSFERRED).toEqual(DEFAULT_NOTIFICATION_PREFERENCE);
    expect(map.MEMBER_REMOVED).toEqual(DEFAULT_NOTIFICATION_PREFERENCE);
  });

  it("a row can disable both channels for its type", () => {
    const map = buildNotificationPreferenceMap([
      { type: "INVOICE_STATUS_CHANGED", inAppEnabled: false, emailEnabled: false },
    ]);
    expect(map.INVOICE_STATUS_CHANGED).toEqual({ inAppEnabled: false, emailEnabled: false });
  });

  it("rows for every type all override correctly, none fall back to default", () => {
    const rows = NOTIFICATION_TYPES.map((type, i) => ({
      type,
      inAppEnabled: i % 2 === 0,
      emailEnabled: i % 2 !== 0,
    }));
    const map = buildNotificationPreferenceMap(rows);
    rows.forEach((row) => {
      expect(map[row.type]).toEqual({ inAppEnabled: row.inAppEnabled, emailEnabled: row.emailEnabled });
    });
  });

  it("the returned map always has exactly the 6 known keys, regardless of input", () => {
    const map = buildNotificationPreferenceMap([
      { type: "ROLE_CHANGED", inAppEnabled: false, emailEnabled: false },
    ]);
    expect(Object.keys(map).sort()).toEqual([...NOTIFICATION_TYPES].sort());
  });
});

describe("shouldDeliverInApp", () => {
  it("no preference (undefined) defaults to true", () => {
    expect(shouldDeliverInApp(undefined)).toBe(true);
  });

  it("no preference (null) defaults to true", () => {
    expect(shouldDeliverInApp(null)).toBe(true);
  });

  it("an explicit true stays true", () => {
    expect(shouldDeliverInApp({ inAppEnabled: true, emailEnabled: false })).toBe(true);
  });

  it("an explicit false is respected", () => {
    expect(shouldDeliverInApp({ inAppEnabled: false, emailEnabled: true })).toBe(false);
  });
});

describe("shouldDeliverEmail", () => {
  it("no preference (undefined) defaults to true", () => {
    expect(shouldDeliverEmail(undefined)).toBe(true);
  });

  it("no preference (null) defaults to true", () => {
    expect(shouldDeliverEmail(null)).toBe(true);
  });

  it("an explicit true stays true", () => {
    expect(shouldDeliverEmail({ inAppEnabled: false, emailEnabled: true })).toBe(true);
  });

  it("an explicit false is respected", () => {
    expect(shouldDeliverEmail({ inAppEnabled: true, emailEnabled: false })).toBe(false);
  });

  it("in-app and email are independent — disabling one never affects the other", () => {
    const bothOff = { inAppEnabled: false, emailEnabled: false };
    expect(shouldDeliverInApp(bothOff)).toBe(false);
    expect(shouldDeliverEmail(bothOff)).toBe(false);

    const onlyEmailOff = { inAppEnabled: true, emailEnabled: false };
    expect(shouldDeliverInApp(onlyEmailOff)).toBe(true);
    expect(shouldDeliverEmail(onlyEmailOff)).toBe(false);
  });
});
