import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InvoicePdfObjectIdentity, InvoicePdfRemoveResult } from "@/lib/invoices/pdf/storage";

// archive-compensation.ts imports the real "server-only" marker package —
// see test/unit/invoice-pdf-view-model.test.ts's own header comment for
// the identical, already-established precedent.
vi.mock("server-only", () => ({}));

/**
 * Invoice System Official Slice 3, Legacy Archive — direct, isolated unit
 * coverage for the shared compensateArchiveUpload() helper (extracted from
 * issue-invoice.ts's own former private compensateUpload(), sub-PR 3b),
 * exercised in complete isolation from both Issue and Legacy Archive.
 *
 * @/lib/prisma is mocked BEFORE compensateArchiveUpload() is imported, so
 * no real database is ever touched here — this file belongs to
 * vitest.config.mts's own unit suite (no PGlite harness, no globalSetup).
 * The end-to-end, real-Storage/real-Prisma proof for every one of these
 * same states lives in test/integration/invoices/legacy-archive.test.ts;
 * this file's own job is narrower: prove the helper's exact internal
 * branching and exact updateMany where/data contract, independent of any
 * caller.
 */

const updateManyMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    invoicePdfArchiveObject: {
      updateMany: updateManyMock,
    },
  },
}));

const { compensateArchiveUpload } = await import("@/lib/invoices/pdf/archive-compensation");

const LEDGER_ID = "11111111-1111-4111-8111-111111111111";
const IDENTITY: InvoicePdfObjectIdentity = {
  organizationId: "22222222-2222-4222-8222-222222222222",
  invoiceId: "33333333-3333-4333-8333-333333333333",
  documentVersion: 1,
  archiveId: LEDGER_ID,
};
const NOW = new Date("2026-08-19T12:00:00.000Z");

beforeEach(() => {
  updateManyMock.mockReset();
});

describe("compensateArchiveUpload — state A: removal succeeds, ledger transition succeeds", () => {
  it("calls updateMany with the exact CLEANED where/data contract, and resolves without throwing", async () => {
    let objectPresent = true;
    const remove = vi.fn(async (): Promise<InvoicePdfRemoveResult> => {
      objectPresent = false;
      return { ok: true };
    });
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    await expect(compensateArchiveUpload({ remove }, LEDGER_ID, IDENTITY, NOW)).resolves.toBeUndefined();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith({ identity: IDENTITY });
    expect(objectPresent).toBe(false);

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: LEDGER_ID, status: "PENDING_UPLOAD", cleanupLockedAt: null, cleanupClaimToken: null },
      data: { status: "CLEANED", cleanedAt: NOW },
    });
  });
});

describe("compensateArchiveUpload — state B: removal succeeds, ledger transition fails", () => {
  it("still resolves without throwing; the object is confirmed removed even though the ledger mutation itself never succeeded (representing the original row staying PENDING_UPLOAD)", async () => {
    let objectPresent = true;
    const remove = vi.fn(async (): Promise<InvoicePdfRemoveResult> => {
      objectPresent = false;
      return { ok: true };
    });
    updateManyMock.mockRejectedValueOnce(new Error("simulated ledger-transition database failure"));

    await expect(compensateArchiveUpload({ remove }, LEDGER_ID, IDENTITY, NOW)).resolves.toBeUndefined();

    expect(objectPresent).toBe(false);
    // Exactly one CLEANED-transition attempt was made — configured above
    // to reject — and the helper resolving without throwing proves it
    // caught that rejection internally rather than propagating it. No
    // other, successful ledger mutation was ever attempted.
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: LEDGER_ID, status: "PENDING_UPLOAD", cleanupLockedAt: null, cleanupClaimToken: null },
      data: { status: "CLEANED", cleanedAt: NOW },
    });
  });
});

describe("compensateArchiveUpload — state C: removal fails (bounded reason), ledger transition succeeds", () => {
  it("calls updateMany with the exact CLEANUP_PENDING data, incrementing the attempt count by one with the bounded failure category, and resolves without throwing", async () => {
    const objectPresent = true;
    const remove = vi.fn(async (): Promise<InvoicePdfRemoveResult> => {
      // Object stays present — removal genuinely failed.
      return { ok: false, reason: "remove_failed" };
    });
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    await expect(compensateArchiveUpload({ remove }, LEDGER_ID, IDENTITY, NOW)).resolves.toBeUndefined();

    expect(objectPresent).toBe(true);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: LEDGER_ID, status: "PENDING_UPLOAD", cleanupLockedAt: null, cleanupClaimToken: null },
      data: {
        status: "CLEANUP_PENDING",
        cleanupAttemptCount: { increment: 1 },
        lastCleanupFailureCategory: "remove_failed",
      },
    });
  });
});

describe("compensateArchiveUpload — state D: removal fails, ledger transition also fails", () => {
  it("resolves without throwing; no successful ledger mutation occurred (representing the row staying PENDING_UPLOAD), and the object remains present", async () => {
    const objectPresent = true;
    const remove = vi.fn(async (): Promise<InvoicePdfRemoveResult> => ({ ok: false, reason: "remove_failed" }));
    updateManyMock.mockRejectedValueOnce(new Error("simulated ledger-transition database failure"));

    await expect(compensateArchiveUpload({ remove }, LEDGER_ID, IDENTITY, NOW)).resolves.toBeUndefined();

    expect(objectPresent).toBe(true);
    // Exactly one CLEANUP_PENDING-transition attempt was made —
    // configured above to reject — and the helper resolving without
    // throwing proves it caught that rejection internally. No other,
    // successful ledger mutation was ever attempted; the row conceptually
    // remains PENDING_UPLOAD.
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: LEDGER_ID, status: "PENDING_UPLOAD", cleanupLockedAt: null, cleanupClaimToken: null },
      data: {
        status: "CLEANUP_PENDING",
        cleanupAttemptCount: { increment: 1 },
        lastCleanupFailureCategory: "remove_failed",
      },
    });
  });
});

describe("compensateArchiveUpload — C2: a thrown remove() is normalized to the bounded remove_failed category (not state D)", () => {
  it("never lets the raw exception escape or reach updateMany's data, and still resolves the CLEANUP_PENDING transition (ledger succeeds in this variant)", async () => {
    const rawError = new Error("simulated storage provider exception during removal — must never be persisted or thrown");
    const remove = vi.fn(async (): Promise<InvoicePdfRemoveResult> => {
      throw rawError;
    });
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    await expect(compensateArchiveUpload({ remove }, LEDGER_ID, IDENTITY, NOW)).resolves.toBeUndefined();

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    const call = updateManyMock.mock.calls[0][0];
    expect(call.data.status).toBe("CLEANUP_PENDING");
    expect(call.data.lastCleanupFailureCategory).toBe("remove_failed");
    // The raw Error's own message never appears anywhere in the recorded call.
    expect(JSON.stringify(call)).not.toContain(rawError.message);
  });
});
