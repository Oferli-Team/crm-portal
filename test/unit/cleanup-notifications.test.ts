import { describe, expect, it } from "vitest";
import { isEligibleForCleanup, NOTIFICATION_RETENTION_MS } from "@/lib/notifications/jobs/cleanup-notifications";

const NOW = new Date("2026-08-03T12:00:00.000Z");

describe("isEligibleForCleanup", () => {
  it("a read notification older than the retention window is eligible", () => {
    const readAt = new Date(NOW.getTime() - NOTIFICATION_RETENTION_MS - 1000);
    expect(isEligibleForCleanup({ readAt }, NOW)).toBe(true);
  });

  it("an unread notification is never eligible, regardless of age", () => {
    expect(isEligibleForCleanup({ readAt: null }, NOW)).toBe(false);
  });

  it("a read notification younger than the retention window remains (not eligible)", () => {
    const readAt = new Date(NOW.getTime() - 1000);
    expect(isEligibleForCleanup({ readAt }, NOW)).toBe(false);
  });

  it("a read notification exactly at the retention boundary is NOT yet eligible (strictly older-than)", () => {
    const readAt = new Date(NOW.getTime() - NOTIFICATION_RETENTION_MS);
    expect(isEligibleForCleanup({ readAt }, NOW)).toBe(false);
  });

  it("a read notification one millisecond past the boundary is eligible", () => {
    const readAt = new Date(NOW.getTime() - NOTIFICATION_RETENTION_MS - 1);
    expect(isEligibleForCleanup({ readAt }, NOW)).toBe(true);
  });

  it("is deterministic for the same caller-supplied now", () => {
    const readAt = new Date(NOW.getTime() - NOTIFICATION_RETENTION_MS - 5000);
    expect(isEligibleForCleanup({ readAt }, NOW)).toBe(isEligibleForCleanup({ readAt }, NOW));
  });
});
