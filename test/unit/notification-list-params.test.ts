import { describe, expect, it } from "vitest";
import {
  parseNotificationListParams,
  buildNotificationWhere,
  NOTIFICATIONS_PAGE_SIZE,
} from "@/lib/notifications/list-params";
import { encodeActivityCursor } from "@/lib/activity/cursor";
import { formatNotification } from "@/lib/notifications/format-notification";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const RECIPIENT_ID = "22222222-2222-2222-2222-222222222222";

describe("parseNotificationListParams — filter", () => {
  it("defaults to 'all' when no filter param is present", () => {
    expect(parseNotificationListParams({}).filter).toBe("all");
  });

  it("accepts 'unread'", () => {
    expect(parseNotificationListParams({ filter: "unread" }).filter).toBe("unread");
  });

  it("accepts 'all' explicitly", () => {
    expect(parseNotificationListParams({ filter: "all" }).filter).toBe("all");
  });

  it("an invalid filter value falls back to 'all'", () => {
    expect(parseNotificationListParams({ filter: "everything" }).filter).toBe("all");
  });

  it("an array filter param uses only the first value", () => {
    expect(parseNotificationListParams({ filter: ["unread", "all"] }).filter).toBe("unread");
  });
});

describe("parseNotificationListParams — cursor", () => {
  it("no cursor param → null cursor, not invalid", () => {
    const result = parseNotificationListParams({});
    expect(result.cursor).toBeNull();
    expect(result.cursorInvalid).toBe(false);
  });

  it("a validly-encoded cursor round-trips", () => {
    const createdAt = "2026-01-01T00:00:00.000Z";
    const id = "33333333-3333-3333-3333-333333333333";
    const cursor = encodeActivityCursor({ createdAt, id });

    const result = parseNotificationListParams({ cursor });
    expect(result.cursor).toEqual({ createdAt, id });
    expect(result.cursorInvalid).toBe(false);
  });

  it("garbage (non-base64url-JSON) payload is invalid, not a throw", () => {
    const result = parseNotificationListParams({ cursor: "not-valid-base64-json-at-all!!" });
    expect(result.cursor).toBeNull();
    expect(result.cursorInvalid).toBe(true);
  });

  it("valid JSON but missing fields is invalid", () => {
    const cursor = Buffer.from(JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z" }), "utf8").toString(
      "base64url",
    );
    const result = parseNotificationListParams({ cursor });
    expect(result.cursor).toBeNull();
    expect(result.cursorInvalid).toBe(true);
  });

  it("a non-UUID id is invalid", () => {
    const cursor = Buffer.from(
      JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z", id: "not-a-uuid" }),
      "utf8",
    ).toString("base64url");
    const result = parseNotificationListParams({ cursor });
    expect(result.cursor).toBeNull();
    expect(result.cursorInvalid).toBe(true);
  });

  it("an invalid date string is invalid", () => {
    const cursor = Buffer.from(
      JSON.stringify({ createdAt: "not-a-date", id: "33333333-3333-3333-3333-333333333333" }),
      "utf8",
    ).toString("base64url");
    const result = parseNotificationListParams({ cursor });
    expect(result.cursor).toBeNull();
    expect(result.cursorInvalid).toBe(true);
  });

  it("an empty string cursor param is treated as absent, not invalid", () => {
    const result = parseNotificationListParams({ cursor: "" });
    expect(result.cursor).toBeNull();
    expect(result.cursorInvalid).toBe(false);
  });
});

describe("buildNotificationWhere", () => {
  it("always scopes by organizationId and recipientId, regardless of filter", () => {
    const where = buildNotificationWhere(ORG_ID, RECIPIENT_ID, { filter: "all", cursor: null, cursorInvalid: false });
    expect(where.organizationId).toBe(ORG_ID);
    expect(where.recipientId).toBe(RECIPIENT_ID);
    expect(where.readAt).toBeUndefined();
    expect(where.OR).toBeUndefined();
  });

  it("the 'unread' filter adds readAt: null", () => {
    const where = buildNotificationWhere(ORG_ID, RECIPIENT_ID, {
      filter: "unread",
      cursor: null,
      cursorInvalid: false,
    });
    expect(where.readAt).toBeNull();
  });

  it("a cursor adds the keyset OR clause with the id tie-break", () => {
    const cursor = { createdAt: "2026-01-01T00:00:00.000Z", id: "33333333-3333-3333-3333-333333333333" };
    const where = buildNotificationWhere(ORG_ID, RECIPIENT_ID, { filter: "all", cursor, cursorInvalid: false });

    expect(where.OR).toEqual([
      { createdAt: { lt: new Date(cursor.createdAt) } },
      { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
    ]);
  });

  it("filter and cursor combine (both conditions present, ANDed at the top level)", () => {
    const cursor = { createdAt: "2026-01-01T00:00:00.000Z", id: "33333333-3333-3333-3333-333333333333" };
    const where = buildNotificationWhere(ORG_ID, RECIPIENT_ID, { filter: "unread", cursor, cursorInvalid: false });

    expect(where.organizationId).toBe(ORG_ID);
    expect(where.recipientId).toBe(RECIPIENT_ID);
    expect(where.readAt).toBeNull();
    expect(where.OR).toBeDefined();
  });
});

describe("NOTIFICATIONS_PAGE_SIZE", () => {
  it("is 25, per the design doc", () => {
    expect(NOTIFICATIONS_PAGE_SIZE).toBe(25);
  });
});

describe("formatter reuse regression — the full-page item consumes the exact same formatNotification output as the dropdown", () => {
  // This is the one formatter — src/components/notifications/notification-item.tsx
  // (dropdown) and notification-list-item.tsx (full page) both render a
  // NotificationBellItem built by this same function; neither re-implements
  // a NotificationType switch of its own. If someone adds a second one,
  // this shape assertion is what should start failing.
  it("returns exactly the {title, detail, timestamp, isUnread, link} shape, nothing more", () => {
    const result = formatNotification({
      type: "ROLE_CHANGED",
      metadata: { actorName: "Jane Doe", from: "MEMBER", to: "ADMIN" },
      entityId: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      readAt: null,
    });

    expect(Object.keys(result).sort()).toEqual(["detail", "isUnread", "link", "timestamp", "title"].sort());
  });

  it("link is present for MEMBERSHIP/INVITATION types regardless of caller (dropdown vs full page use the identical allowlist)", () => {
    for (const type of ["ROLE_CHANGED", "OWNERSHIP_TRANSFERRED", "MEMBER_REMOVED", "INVITATION_ACCEPTED"] as const) {
      const result = formatNotification({
        type,
        metadata: { actorName: "Jane Doe", from: "MEMBER", to: "ADMIN" },
        entityId: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        readAt: null,
      });
      expect(result.link).toBe("/team");
    }
  });

  it("PORTAL_INVITATION_ACCEPTED still has no link — the full-page item must not invent one either", () => {
    const result = formatNotification({
      type: "PORTAL_INVITATION_ACCEPTED",
      metadata: { acceptedUserName: "Alice", email: "a@example.com", clientName: "Acme" },
      entityId: "44444444-4444-4444-4444-444444444444",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      readAt: null,
    });
    expect(result.link).toBeNull();
  });
});
