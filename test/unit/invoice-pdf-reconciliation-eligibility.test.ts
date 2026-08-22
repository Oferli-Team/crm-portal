import { describe, expect, it, vi } from "vitest";
import type { ReconciliationCandidateRow } from "@/lib/invoices/pdf/reconcile-archive-objects";

// reconcile-archive-objects.ts imports the real "server-only" marker
// package — see test/unit/cron-auth.test.ts's own header comment for the
// identical, already-established precedent.
vi.mock("server-only", () => ({}));

const {
  isReconciliationCandidate,
  resolveBatchSize,
  BATCH_SIZE,
  SAFETY_WINDOW_MS,
  CLEANUP_LEASE_MS,
  MAX_CLEANUP_ATTEMPTS,
  MAX_VERCEL_FUNCTION_DURATION_MS,
} = await import("@/lib/invoices/pdf/reconcile-archive-objects");

/**
 * Bounded Archival Reconciliation/Cleanup — pure, unit-testable coverage
 * for isReconciliationCandidate(), which mirrors candidateWhere()'s own
 * Prisma WHERE clause exactly (see that function's own doc comment for why
 * this duplication is unavoidable). The real SQL is verified to match this
 * pure predicate via test/integration/invoices/reconcile-archive-objects.test.ts.
 */

const NOW = new Date("2026-08-20T12:00:00.000Z");

function row(overrides: Partial<ReconciliationCandidateRow> = {}): ReconciliationCandidateRow {
  return {
    status: "PENDING_UPLOAD",
    cleanupLockedAt: null,
    cleanupClaimToken: null,
    cleanupAttemptCount: 0,
    createdAt: new Date(NOW.getTime() - SAFETY_WINDOW_MS - 60_000),
    ...overrides,
  };
}

describe("isReconciliationCandidate — PENDING_UPLOAD safety-window boundary", () => {
  it("exactly at the safety threshold is NOT yet eligible", () => {
    const candidate = row({ createdAt: new Date(NOW.getTime() - SAFETY_WINDOW_MS) });
    expect(isReconciliationCandidate(candidate, NOW)).toBe(false);
  });

  it("one millisecond older than the safety threshold IS eligible", () => {
    const candidate = row({ createdAt: new Date(NOW.getTime() - SAFETY_WINDOW_MS - 1) });
    expect(isReconciliationCandidate(candidate, NOW)).toBe(true);
  });

  it("one millisecond younger than the safety threshold is NOT eligible", () => {
    const candidate = row({ createdAt: new Date(NOW.getTime() - SAFETY_WINDOW_MS + 1) });
    expect(isReconciliationCandidate(candidate, NOW)).toBe(false);
  });

  it("a genuinely fresh PENDING_UPLOAD row (created moments ago) is never eligible", () => {
    const candidate = row({ createdAt: new Date(NOW.getTime() - 5_000) });
    expect(isReconciliationCandidate(candidate, NOW)).toBe(false);
  });
});

describe("isReconciliationCandidate — claim-lease boundary", () => {
  function claimedRow(cleanupLockedAt: Date, overrides: Partial<ReconciliationCandidateRow> = {}) {
    return row({ cleanupLockedAt, cleanupClaimToken: "11111111-1111-4111-8111-111111111111", ...overrides });
  }

  it("exactly at the stale-lease threshold is NOT reclaimable", () => {
    const candidate = claimedRow(new Date(NOW.getTime() - CLEANUP_LEASE_MS));
    expect(isReconciliationCandidate(candidate, NOW)).toBe(false);
  });

  it("one millisecond older than the stale-lease threshold IS reclaimable", () => {
    const candidate = claimedRow(new Date(NOW.getTime() - CLEANUP_LEASE_MS - 1));
    expect(isReconciliationCandidate(candidate, NOW)).toBe(true);
  });

  it("an actively-held (fresh) claim is NOT reclaimable/eligible", () => {
    const candidate = claimedRow(new Date(NOW.getTime() - 5_000));
    expect(isReconciliationCandidate(candidate, NOW)).toBe(false);
  });

  it("a normally unclaimed row (both fields null) is eligible, subject to its own status/age rules", () => {
    const candidate = row({ cleanupLockedAt: null, cleanupClaimToken: null });
    expect(isReconciliationCandidate(candidate, NOW)).toBe(true);
  });
});

describe("isReconciliationCandidate — torn lock/token pairs never eligible (fail closed, never auto-healed)", () => {
  it("cleanupLockedAt null + cleanupClaimToken non-null is never eligible, however old", () => {
    const candidate = row({
      cleanupLockedAt: null,
      cleanupClaimToken: "22222222-2222-4222-8222-222222222222",
      createdAt: new Date(0), // maximally old
    });
    expect(isReconciliationCandidate(candidate, NOW)).toBe(false);
  });

  it("cleanupLockedAt non-null + cleanupClaimToken null is never eligible, however old the lock", () => {
    const candidate = row({
      cleanupLockedAt: new Date(0), // maximally old — would satisfy the stale-lease check on its own
      cleanupClaimToken: null,
    });
    expect(isReconciliationCandidate(candidate, NOW)).toBe(false);
  });
});

describe("isReconciliationCandidate — status group", () => {
  it("CLEANUP_PENDING is eligible regardless of age, under the attempt ceiling", () => {
    const candidate = row({ status: "CLEANUP_PENDING", createdAt: NOW, cleanupAttemptCount: MAX_CLEANUP_ATTEMPTS - 1 });
    expect(isReconciliationCandidate(candidate, NOW)).toBe(true);
  });

  it("CLEANUP_PENDING at the attempt ceiling is NOT eligible", () => {
    const candidate = row({ status: "CLEANUP_PENDING", cleanupAttemptCount: MAX_CLEANUP_ATTEMPTS });
    expect(isReconciliationCandidate(candidate, NOW)).toBe(false);
  });

  it("PENDING_UPLOAD at the attempt ceiling is NOT eligible even when old enough", () => {
    const candidate = row({ status: "PENDING_UPLOAD", cleanupAttemptCount: MAX_CLEANUP_ATTEMPTS });
    expect(isReconciliationCandidate(candidate, NOW)).toBe(false);
  });

  it("PENDING_UPLOAD one below the attempt ceiling, old enough, is eligible", () => {
    const candidate = row({ status: "PENDING_UPLOAD", cleanupAttemptCount: MAX_CLEANUP_ATTEMPTS - 1 });
    expect(isReconciliationCandidate(candidate, NOW)).toBe(true);
  });

  it("REFERENCED is never eligible, regardless of every other field", () => {
    const candidate = row({ status: "REFERENCED", createdAt: new Date(0), cleanupAttemptCount: 0 });
    expect(isReconciliationCandidate(candidate, NOW)).toBe(false);
  });

  it("CLEANED is never eligible, regardless of every other field", () => {
    const candidate = row({ status: "CLEANED", createdAt: new Date(0), cleanupAttemptCount: 0 });
    expect(isReconciliationCandidate(candidate, NOW)).toBe(false);
  });
});

describe("resolveBatchSize — the single resolver both exported workers use for params.batchSize", () => {
  it("undefined resolves to BATCH_SIZE", () => {
    expect(resolveBatchSize(undefined)).toBe(BATCH_SIZE);
  });

  it("0 is accepted as-is (supports existing deterministic no-candidate tests)", () => {
    expect(resolveBatchSize(0)).toBe(0);
  });

  it("1 is accepted as-is", () => {
    expect(resolveBatchSize(1)).toBe(1);
  });

  it("BATCH_SIZE itself is accepted as-is (the inclusive upper bound)", () => {
    expect(resolveBatchSize(BATCH_SIZE)).toBe(BATCH_SIZE);
  });

  it("-1 (negative) throws a RangeError", () => {
    expect(() => resolveBatchSize(-1)).toThrow(RangeError);
  });

  it("BATCH_SIZE + 1 (over the bound) throws a RangeError", () => {
    expect(() => resolveBatchSize(BATCH_SIZE + 1)).toThrow(RangeError);
  });

  it("1.5 (fractional) throws a RangeError", () => {
    expect(() => resolveBatchSize(1.5)).toThrow(RangeError);
  });

  it("NaN throws a RangeError", () => {
    expect(() => resolveBatchSize(NaN)).toThrow(RangeError);
  });

  it("Infinity throws a RangeError", () => {
    expect(() => resolveBatchSize(Infinity)).toThrow(RangeError);
  });
});

describe("Bounded Archival Reconciliation/Cleanup — constant safety relationships", () => {
  it("SAFETY_WINDOW_MS exceeds MAX_VERCEL_FUNCTION_DURATION_MS — the stale-uploader structural proof", () => {
    expect(SAFETY_WINDOW_MS).toBeGreaterThan(MAX_VERCEL_FUNCTION_DURATION_MS);
  });

  it("CLEANUP_LEASE_MS exceeds the reconciliation routes' own configured 60-second maxDuration", () => {
    expect(CLEANUP_LEASE_MS).toBeGreaterThan(60_000);
  });

  it("the exact documented values are what shipped", () => {
    expect(SAFETY_WINDOW_MS).toBe(30 * 60 * 1000);
    expect(CLEANUP_LEASE_MS).toBe(10 * 60 * 1000);
    expect(MAX_CLEANUP_ATTEMPTS).toBe(20);
    expect(MAX_VERCEL_FUNCTION_DURATION_MS).toBe(15 * 60 * 1000);
  });
});
