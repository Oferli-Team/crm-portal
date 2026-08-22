import { describe, expect, it } from "vitest";
import { isEligibleForRetryClaim, STALE_LOCK_MS } from "@/lib/notifications/jobs/retry-notification-deliveries";
import { MAX_ATTEMPTS } from "@/lib/notifications/email/deliver-notification-email";

const NOW = new Date("2026-08-03T12:00:00.000Z");

const BASE = {
  status: "PENDING" as const,
  attemptCount: 0,
  nextAttemptAt: null,
  lockedAt: null,
};

describe("isEligibleForRetryClaim — PENDING", () => {
  it("PENDING is always eligible", () => {
    expect(isEligibleForRetryClaim({ ...BASE, status: "PENDING" }, NOW)).toBe(true);
  });
});

describe("isEligibleForRetryClaim — FAILED", () => {
  it("FAILED with no nextAttemptAt and attempts remaining is eligible", () => {
    expect(
      isEligibleForRetryClaim({ ...BASE, status: "FAILED", attemptCount: 1, nextAttemptAt: null }, NOW),
    ).toBe(true);
  });

  it("FAILED is eligible once nextAttemptAt has passed", () => {
    const nextAttemptAt = new Date(NOW.getTime() - 1000);
    expect(
      isEligibleForRetryClaim({ ...BASE, status: "FAILED", attemptCount: 1, nextAttemptAt }, NOW),
    ).toBe(true);
  });

  it("FAILED is eligible exactly at nextAttemptAt (inclusive boundary)", () => {
    expect(
      isEligibleForRetryClaim({ ...BASE, status: "FAILED", attemptCount: 1, nextAttemptAt: NOW }, NOW),
    ).toBe(true);
  });

  it("FAILED is NOT eligible before its nextAttemptAt", () => {
    const nextAttemptAt = new Date(NOW.getTime() + 1000);
    expect(
      isEligibleForRetryClaim({ ...BASE, status: "FAILED", attemptCount: 1, nextAttemptAt }, NOW),
    ).toBe(false);
  });

  it("FAILED is NOT eligible once attemptCount has reached MAX_ATTEMPTS, regardless of nextAttemptAt", () => {
    expect(
      isEligibleForRetryClaim(
        { ...BASE, status: "FAILED", attemptCount: MAX_ATTEMPTS, nextAttemptAt: null },
        NOW,
      ),
    ).toBe(false);
  });

  it("FAILED is NOT eligible past MAX_ATTEMPTS", () => {
    expect(
      isEligibleForRetryClaim(
        { ...BASE, status: "FAILED", attemptCount: MAX_ATTEMPTS + 5, nextAttemptAt: null },
        NOW,
      ),
    ).toBe(false);
  });
});

describe("isEligibleForRetryClaim — PROCESSING (stale-lock recovery)", () => {
  it("PROCESSING with no lockedAt at all is not eligible (shouldn't happen, but fail safe)", () => {
    expect(isEligibleForRetryClaim({ ...BASE, status: "PROCESSING", lockedAt: null }, NOW)).toBe(false);
  });

  it("PROCESSING locked longer ago than the stale threshold is eligible for reclaim", () => {
    const lockedAt = new Date(NOW.getTime() - STALE_LOCK_MS - 1000);
    expect(isEligibleForRetryClaim({ ...BASE, status: "PROCESSING", lockedAt }, NOW)).toBe(true);
  });

  it("PROCESSING locked exactly at the stale threshold is NOT yet eligible (strictly greater-than)", () => {
    const lockedAt = new Date(NOW.getTime() - STALE_LOCK_MS);
    expect(isEligibleForRetryClaim({ ...BASE, status: "PROCESSING", lockedAt }, NOW)).toBe(false);
  });

  it("PROCESSING locked recently (still within an active run's window) is NOT eligible", () => {
    const lockedAt = new Date(NOW.getTime() - 1000);
    expect(isEligibleForRetryClaim({ ...BASE, status: "PROCESSING", lockedAt }, NOW)).toBe(false);
  });

  it("honors a caller-supplied staleLockMs override instead of the default", () => {
    const lockedAt = new Date(NOW.getTime() - 5000);
    expect(isEligibleForRetryClaim({ ...BASE, status: "PROCESSING", lockedAt }, NOW, 1000)).toBe(true);
    expect(isEligibleForRetryClaim({ ...BASE, status: "PROCESSING", lockedAt }, NOW, 60_000)).toBe(false);
  });
});

describe("isEligibleForRetryClaim — terminal statuses", () => {
  it("SENT is never eligible", () => {
    expect(isEligibleForRetryClaim({ ...BASE, status: "SENT" }, NOW)).toBe(false);
  });

  it("SKIPPED is never eligible", () => {
    expect(isEligibleForRetryClaim({ ...BASE, status: "SKIPPED" }, NOW)).toBe(false);
  });
});

describe("isEligibleForRetryClaim — determinism", () => {
  it("is a pure function of its inputs — same row/now/staleLockMs always yields the same result", () => {
    const row = { ...BASE, status: "FAILED" as const, attemptCount: 1, nextAttemptAt: null };
    const first = isEligibleForRetryClaim(row, NOW);
    const second = isEligibleForRetryClaim(row, NOW);
    expect(first).toBe(second);
  });
});
