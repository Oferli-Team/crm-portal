import { describe, expect, it } from "vitest";
import type { Notification } from "@/generated/prisma/client";
import { buildNotificationDigestModel } from "@/lib/notifications/jobs/digest-candidates";

const BASE = {
  organizationId: "org-1",
  recipientId: "user-1",
  activityId: null,
  entityType: null,
};

function notification(overrides: Partial<Notification>): Notification {
  return {
    ...BASE,
    id: "n-1",
    type: "ROLE_CHANGED",
    entityId: null,
    metadata: {},
    readAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  } as Notification;
}

describe("buildNotificationDigestModel — grouping", () => {
  it("groups notifications by type, in canonical NOTIFICATION_TYPES order regardless of input order", () => {
    const model = buildNotificationDigestModel([
      notification({ id: "n-1", type: "INVOICE_STATUS_CHANGED", metadata: { invoiceNumber: "INV-1" } }),
      notification({ id: "n-2", type: "ROLE_CHANGED", metadata: {} }),
      notification({ id: "n-3", type: "OWNERSHIP_TRANSFERRED", metadata: {} }),
    ]);

    expect(model.groups.map((g) => g.type)).toEqual(["ROLE_CHANGED", "OWNERSHIP_TRANSFERRED", "INVOICE_STATUS_CHANGED"]);
  });

  it("multiple notifications of the same type land in one group, in the order they were given", () => {
    const model = buildNotificationDigestModel([
      notification({ id: "n-1", type: "ROLE_CHANGED" }),
      notification({ id: "n-2", type: "ROLE_CHANGED" }),
    ]);

    expect(model.groups).toHaveLength(1);
    expect(model.groups[0].items.map((i) => i.id)).toEqual(["n-1", "n-2"]);
  });

  it("an empty input produces an empty model", () => {
    const model = buildNotificationDigestModel([]);
    expect(model).toEqual({ totalCount: 0, groups: [] });
  });
});

describe("buildNotificationDigestModel — dedupe", () => {
  it("dedupes by Notification id, keeping only the first occurrence", () => {
    const model = buildNotificationDigestModel([
      notification({ id: "n-1", type: "ROLE_CHANGED" }),
      notification({ id: "n-1", type: "ROLE_CHANGED" }),
    ]);

    expect(model.totalCount).toBe(1);
    expect(model.groups[0].items).toHaveLength(1);
  });
});

describe("buildNotificationDigestModel — malformed metadata is handled safely", () => {
  // INVOICE_STATUS_CHANGED is the one type whose formatter can't produce a
  // meaningful title without a specific metadata field (invoiceNumber) —
  // every other type (e.g. ROLE_CHANGED) degrades gracefully to a generic
  // actor name instead, so it's the type that actually exercises the
  // FALLBACK_TITLE branch when metadata is missing/malformed.
  it("non-object metadata falls back to a safe generic display, never throws", () => {
    expect(() =>
      buildNotificationDigestModel([
        notification({ id: "n-1", type: "INVOICE_STATUS_CHANGED", metadata: "not-an-object" as never }),
      ]),
    ).not.toThrow();

    const model = buildNotificationDigestModel([
      notification({ id: "n-1", type: "INVOICE_STATUS_CHANGED", metadata: "not-an-object" as never }),
    ]);
    expect(model.groups[0].items[0].title).toBe("Notification received");
  });

  it("null metadata is handled safely", () => {
    const model = buildNotificationDigestModel([
      notification({ id: "n-1", type: "INVOICE_STATUS_CHANGED", metadata: null as never }),
    ]);
    expect(model.groups[0].items[0].title).toBe("Notification received");
  });

  it("a type whose formatter always succeeds (ROLE_CHANGED) degrades to a generic actor name, not a crash, on empty metadata", () => {
    const model = buildNotificationDigestModel([notification({ id: "n-1", type: "ROLE_CHANGED", metadata: {} })]);
    expect(model.groups[0].items[0].title).toBe("Someone changed your role");
  });
});

describe("buildNotificationDigestModel — purity / no side effects", () => {
  it("never mutates readAt on the input notifications", () => {
    const input = notification({ id: "n-1", type: "ROLE_CHANGED", readAt: null });
    buildNotificationDigestModel([input]);
    expect(input.readAt).toBeNull();
  });

  it("does not mutate the input array or its elements", () => {
    const input = [notification({ id: "n-1", type: "ROLE_CHANGED" })];
    const snapshot = JSON.stringify(input);
    buildNotificationDigestModel(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("reflects the input notification's own readAt as isUnread on the formatted item", () => {
    const model = buildNotificationDigestModel([
      notification({ id: "n-1", type: "ROLE_CHANGED", readAt: new Date("2026-08-02T00:00:00.000Z") }),
    ]);
    expect(model.groups[0].items[0].isUnread).toBe(false);
  });
});
