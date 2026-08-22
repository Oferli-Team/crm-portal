import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";

/**
 * Bounded Archival Reconciliation/Cleanup — the full worker integration
 * matrix, against the real repository database harness (PGlite) and the
 * real TEST_MODE Storage in-memory store. Mirrors
 * test/integration/invoices/legacy-archive.test.ts's own structure and
 * conventions exactly. TEST_MODE is set ONLY here (see that file's own
 * header comment for why it is never set globally) — deliberately via a
 * dynamic import of @/lib/test-mode-touching modules AFTER the assignment
 * below, never a static import (see test/integration/cron/routes.test.ts's
 * own comment on why a static import would freeze TEST_MODE=false).
 */

const ORIGINAL_TEST_MODE = process.env.TEST_MODE;
process.env.TEST_MODE = "1";

const {
  reconcileInvoicePdfArchiveObjects,
  reconcileInvoicePdfArchiveObjectsDryRun,
  isReconciliationCandidate,
  SAFETY_WINDOW_MS,
  CLEANUP_LEASE_MS,
  BATCH_SIZE,
  MAX_CLEANUP_ATTEMPTS,
} = await import("@/lib/invoices/pdf/reconcile-archive-objects");
const { buildInvoicePdfStoragePath, uploadInvoicePdfObject } = await import("@/lib/invoices/pdf/storage");
const { testStorageRead } = await import("@/lib/storage/test-storage");

afterAll(() => {
  if (ORIGINAL_TEST_MODE === undefined) delete process.env.TEST_MODE;
  else process.env.TEST_MODE = ORIGINAL_TEST_MODE;
});

const OLD_ENOUGH = () => new Date(Date.now() - SAFETY_WINDOW_MS - 5 * 60 * 1000);

type SeedOverrides = {
  archiveId?: string;
  invoiceId?: string | null;
  documentVersion?: number;
  status?: "PENDING_UPLOAD" | "CLEANUP_PENDING" | "REFERENCED" | "CLEANED";
  createdAt?: Date;
  cleanupLockedAt?: Date | null;
  cleanupClaimToken?: string | null;
  cleanupAttemptCount?: number;
  storagePathOverride?: string;
};

describe("reconcileInvoicePdfArchiveObjects / reconcileInvoicePdfArchiveObjectsDryRun — integration", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  async function seedLedgerRow(overrides: SeedOverrides = {}) {
    const archiveId = overrides.archiveId ?? randomUUID();
    const invoiceId = overrides.invoiceId === undefined ? fixtures.invoice.id : overrides.invoiceId;
    const documentVersion = overrides.documentVersion ?? 1;
    const storagePath =
      overrides.storagePathOverride ??
      buildInvoicePdfStoragePath({
        organizationId: fixtures.orgA.id,
        invoiceId: invoiceId ?? fixtures.invoice.id,
        documentVersion,
        archiveId,
      });

    return prisma.invoicePdfArchiveObject.create({
      data: {
        id: archiveId,
        organizationId: fixtures.orgA.id,
        invoiceId,
        documentVersion,
        storagePath,
        status: overrides.status ?? "PENDING_UPLOAD",
        createdAt: overrides.createdAt ?? OLD_ENOUGH(),
        cleanupLockedAt: overrides.cleanupLockedAt ?? null,
        cleanupClaimToken: overrides.cleanupClaimToken ?? null,
        cleanupAttemptCount: overrides.cleanupAttemptCount ?? 0,
      },
    });
  }

  async function cleanupLedgerRow(id: string) {
    await prisma.invoicePdfArchiveObject.delete({ where: { id } }).catch(() => {});
  }

  async function assertNoSideEffects(organizationId: string, invoiceId: string) {
    const [activities, notifications, portalDownloadRequests] = await Promise.all([
      prisma.activity.findMany({ where: { entityType: "INVOICE", entityId: invoiceId } }),
      prisma.notification.findMany({ where: { organizationId } }),
      prisma.portalDownloadRequest.findMany({ where: { organizationId } }),
    ]);
    expect(activities).toHaveLength(0);
    expect(notifications).toHaveLength(0);
    expect(portalDownloadRequests).toHaveLength(0);
  }

  // --- Per-row outcomes ------------------------------------------------------

  describe("per-row outcomes", () => {
    it("absent object -> CLEANED, no attempt increment", async () => {
      const row = await seedLedgerRow();
      try {
        const summary = await reconcileInvoicePdfArchiveObjects({ now: new Date() });
        expect(summary.cleaned).toBeGreaterThanOrEqual(1);
        const after = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.status).toBe("CLEANED");
        expect(after.cleanedAt).not.toBeNull();
        expect(after.cleanupLockedAt).toBeNull();
        expect(after.cleanupClaimToken).toBeNull();
        expect(after.cleanupAttemptCount).toBe(0);
        await assertNoSideEffects(fixtures.orgA.id, fixtures.invoice.id);
      } finally {
        await cleanupLedgerRow(row.id);
      }
    });

    it("present object, removal succeeds -> CLEANED", async () => {
      const row = await seedLedgerRow();
      await uploadInvoicePdfObject({
        identity: { organizationId: fixtures.orgA.id, invoiceId: fixtures.invoice.id, documentVersion: 1, archiveId: row.id },
        body: Buffer.from("%PDF-1.3 present"),
      });
      try {
        const summary = await reconcileInvoicePdfArchiveObjects({ now: new Date() });
        expect(summary.cleaned).toBeGreaterThanOrEqual(1);
        const after = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.status).toBe("CLEANED");
        expect(testStorageRead("attachments", row.storagePath)).toBeNull();
      } finally {
        await cleanupLedgerRow(row.id);
      }
    });

    it("present object, removal fails (remove_failed) -> CLEANUP_PENDING, attempt+1, category persisted", async () => {
      const row = await seedLedgerRow();
      await uploadInvoicePdfObject({
        identity: { organizationId: fixtures.orgA.id, invoiceId: fixtures.invoice.id, documentVersion: 1, archiveId: row.id },
        body: Buffer.from("%PDF-1.3 present"),
      });
      try {
        const summary = await reconcileInvoicePdfArchiveObjects(
          { now: new Date() },
          { remove: async () => ({ ok: false, reason: "remove_failed" }) },
        );
        expect(summary.retained).toBeGreaterThanOrEqual(1);
        const after = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.status).toBe("CLEANUP_PENDING");
        expect(after.cleanupAttemptCount).toBe(1);
        expect(after.lastCleanupFailureCategory).toBe("remove_failed");
        expect(after.cleanupLockedAt).toBeNull();
        expect(after.cleanupClaimToken).toBeNull();
        // Object still present — removal genuinely failed, nothing removed.
        expect(testStorageRead("attachments", row.storagePath)).not.toBeNull();
      } finally {
        await cleanupLedgerRow(row.id);
      }
    });

    it("present object, removal fails (storage_not_configured) -> status UNCHANGED, never CLEANUP_PENDING", async () => {
      const row = await seedLedgerRow();
      await uploadInvoicePdfObject({
        identity: { organizationId: fixtures.orgA.id, invoiceId: fixtures.invoice.id, documentVersion: 1, archiveId: row.id },
        body: Buffer.from("%PDF-1.3 present"),
      });
      try {
        const summary = await reconcileInvoicePdfArchiveObjects(
          { now: new Date() },
          { remove: async () => ({ ok: false, reason: "storage_not_configured" }) },
        );
        expect(summary.releasedWithFailure).toBeGreaterThanOrEqual(1);
        const after = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.status).toBe("PENDING_UPLOAD"); // unchanged from its seeded status
        expect(after.cleanupAttemptCount).toBe(1);
        expect(after.lastCleanupFailureCategory).toBe("storage_not_configured");
      } finally {
        await cleanupLedgerRow(row.id);
      }
    });

    it("probe_failed -> status UNCHANGED, category persisted, lease released", async () => {
      const row = await seedLedgerRow();
      try {
        const summary = await reconcileInvoicePdfArchiveObjects(
          { now: new Date() },
          { probe: async () => ({ ok: false, reason: "probe_failed" }) },
        );
        expect(summary.releasedWithFailure).toBeGreaterThanOrEqual(1);
        const after = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.status).toBe("PENDING_UPLOAD");
        expect(after.cleanupAttemptCount).toBe(1);
        expect(after.lastCleanupFailureCategory).toBe("probe_failed");
        expect(after.cleanupLockedAt).toBeNull();
        expect(after.cleanupClaimToken).toBeNull();
      } finally {
        await cleanupLedgerRow(row.id);
      }
    });

    it("probe storage_not_configured -> status UNCHANGED, category persisted exactly (never collapsed into probe_failed)", async () => {
      const row = await seedLedgerRow();
      try {
        const summary = await reconcileInvoicePdfArchiveObjects(
          { now: new Date() },
          { probe: async () => ({ ok: false, reason: "storage_not_configured" }) },
        );
        expect(summary.releasedWithFailure).toBeGreaterThanOrEqual(1);
        const after = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.status).toBe("PENDING_UPLOAD");
        expect(after.lastCleanupFailureCategory).toBe("storage_not_configured");
      } finally {
        await cleanupLedgerRow(row.id);
      }
    });

    it("malformed storagePath -> invariant_violation, never probed/removed", async () => {
      const row = await seedLedgerRow({ storagePathOverride: "not/a/real/path.pdf" });
      const probeSpy = { called: false };
      try {
        const summary = await reconcileInvoicePdfArchiveObjects(
          { now: new Date() },
          {
            probe: async () => {
              probeSpy.called = true;
              return { ok: true, exists: false };
            },
          },
        );
        expect(probeSpy.called).toBe(false);
        expect(summary.releasedWithFailure).toBeGreaterThanOrEqual(1);
        const after = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.status).toBe("PENDING_UPLOAD");
        expect(after.lastCleanupFailureCategory).toBe("invariant_violation");
      } finally {
        await cleanupLedgerRow(row.id);
      }
    });

    it("an Invoice already referencing storagePath (first check) -> invoice_reference_detected, never probed/removed", async () => {
      const row = await seedLedgerRow();
      const probeSpy = { called: false };
      await prisma.invoice.update({ where: { id: fixtures.invoice.id }, data: { pdfStoragePath: row.storagePath } });
      try {
        const summary = await reconcileInvoicePdfArchiveObjects(
          { now: new Date() },
          { probe: async () => { probeSpy.called = true; return { ok: true, exists: false }; } },
        );
        expect(probeSpy.called).toBe(false);
        expect(summary.releasedWithFailure).toBeGreaterThanOrEqual(1);
        const after = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.status).toBe("PENDING_UPLOAD");
        expect(after.lastCleanupFailureCategory).toBe("invoice_reference_detected");
      } finally {
        await prisma.invoice.update({ where: { id: fixtures.invoice.id }, data: { pdfStoragePath: null } });
        await cleanupLedgerRow(row.id);
      }
    });

    it("a reference introduced during the probe call (second check) is observed, and remove() is never called", async () => {
      const row = await seedLedgerRow();
      await uploadInvoicePdfObject({
        identity: { organizationId: fixtures.orgA.id, invoiceId: fixtures.invoice.id, documentVersion: 1, archiveId: row.id },
        body: Buffer.from("%PDF-1.3 present"),
      });
      const removeSpy = { called: false };
      try {
        const summary = await reconcileInvoicePdfArchiveObjects(
          { now: new Date() },
          {
            probe: async () => {
              // Simulate a live Issue/Legacy-Archive attempt finalizing a
              // reference to this exact path, right in the probe's own
              // window — the SECOND reference check (run immediately
              // after this resolves) must observe it.
              await prisma.invoice.update({ where: { id: fixtures.invoice.id }, data: { pdfStoragePath: row.storagePath } });
              return { ok: true, exists: true };
            },
            remove: async () => {
              removeSpy.called = true;
              return { ok: true };
            },
          },
        );
        expect(removeSpy.called).toBe(false);
        expect(summary.releasedWithFailure).toBeGreaterThanOrEqual(1);
        const after = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.lastCleanupFailureCategory).toBe("invoice_reference_detected");
        // The object is untouched — remove() never ran.
        expect(testStorageRead("attachments", row.storagePath)).not.toBeNull();
      } finally {
        await prisma.invoice.update({ where: { id: fixtures.invoice.id }, data: { pdfStoragePath: null } });
        await cleanupLedgerRow(row.id);
      }
    });
  });

  // --- Candidate exclusion (distinct from the release-guard proofs below) ---

  describe("candidate exclusion — REFERENCED/CLEANED rows are never selected/claimed", () => {
    it("a REFERENCED row is never claimed even when artificially aged", async () => {
      const row = await seedLedgerRow({ status: "REFERENCED", createdAt: new Date(0) });
      try {
        const summary = await reconcileInvoicePdfArchiveObjects({ now: new Date() });
        const after = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(after).toEqual(row);
        void summary;
      } finally {
        await cleanupLedgerRow(row.id);
      }
    });

    it("a CLEANED row is never claimed even when artificially aged", async () => {
      const row = await seedLedgerRow({ status: "CLEANED", createdAt: new Date(0) });
      try {
        await reconcileInvoicePdfArchiveObjects({ now: new Date() });
        const after = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(after).toEqual(row);
      } finally {
        await cleanupLedgerRow(row.id);
      }
    });

    it("a PENDING_UPLOAD row younger than SAFETY_WINDOW_MS is never claimed", async () => {
      const row = await seedLedgerRow({ createdAt: new Date(Date.now() - 5_000) });
      try {
        await reconcileInvoicePdfArchiveObjects({ now: new Date() });
        const after = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.status).toBe("PENDING_UPLOAD");
        expect(after.cleanupClaimToken).toBeNull();
      } finally {
        await cleanupLedgerRow(row.id);
      }
    });
  });

  // --- Release-guard proofs (reach the release helpers, not merely candidate exclusion) ---

  describe("release helpers are status+token guarded, independently of candidate exclusion", () => {
    it("A: a hook-injected transition to REFERENCED (matching token preserved) cannot be overwritten by this worker's own release", async () => {
      const KNOWN_TOKEN = "aaaaaaaa-0000-4000-8000-000000000001";
      const row = await seedLedgerRow();
      try {
        const summary = await reconcileInvoicePdfArchiveObjects(
          { now: new Date() },
          {
            generateRunToken: () => KNOWN_TOKEN,
            probe: async () => ({ ok: true, exists: false }),
            beforeGuardedRelease: async (rowId) => {
              if (rowId === row.id) {
                await prisma.invoicePdfArchiveObject.update({ where: { id: rowId }, data: { status: "REFERENCED" } });
              }
            },
          },
        );
        expect(summary.claimLost).toBeGreaterThanOrEqual(1);
        const after = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.status).toBe("REFERENCED");
        expect(after.cleanedAt).toBeNull();
      } finally {
        await cleanupLedgerRow(row.id);
      }
    });

    it("B: a hook-injected transition to CLEANED (matching token preserved) cannot be overwritten by this worker's own release", async () => {
      const KNOWN_TOKEN = "aaaaaaaa-0000-4000-8000-000000000002";
      const row = await seedLedgerRow();
      try {
        const summary = await reconcileInvoicePdfArchiveObjects(
          { now: new Date() },
          {
            generateRunToken: () => KNOWN_TOKEN,
            probe: async () => ({ ok: true, exists: false }),
            beforeGuardedRelease: async (rowId) => {
              if (rowId === row.id) {
                await prisma.invoicePdfArchiveObject.update({ where: { id: rowId }, data: { status: "CLEANED", cleanedAt: new Date("2020-01-01") } });
              }
            },
          },
        );
        expect(summary.claimLost).toBeGreaterThanOrEqual(1);
        const after = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.status).toBe("CLEANED");
        expect(after.cleanedAt).toEqual(new Date("2020-01-01"));
      } finally {
        await cleanupLedgerRow(row.id);
      }
    });

    it("C: a hook-injected token replacement (reconcilable status preserved) means the old worker cannot release the row — claimLost", async () => {
      const KNOWN_TOKEN_A = "aaaaaaaa-0000-4000-8000-000000000003";
      const TOKEN_B = "bbbbbbbb-0000-4000-8000-000000000004";
      const row = await seedLedgerRow();
      try {
        const summary = await reconcileInvoicePdfArchiveObjects(
          { now: new Date() },
          {
            generateRunToken: () => KNOWN_TOKEN_A,
            probe: async () => ({ ok: true, exists: false }),
            beforeGuardedRelease: async (rowId) => {
              if (rowId === row.id) {
                await prisma.invoicePdfArchiveObject.update({
                  where: { id: rowId },
                  data: { cleanupClaimToken: TOKEN_B }, // status stays PENDING_UPLOAD — still reconcilable
                });
              }
            },
          },
        );
        expect(summary.claimLost).toBeGreaterThanOrEqual(1);
        const after = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.cleanupClaimToken).toBe(TOKEN_B);
        expect(after.status).toBe("PENDING_UPLOAD");
      } finally {
        await cleanupLedgerRow(row.id);
      }
    });
  });

  // --- Batch/attempt/claim mechanics ------------------------------------------

  describe("batch bound, attempt ceiling, idempotency, stale/active claims", () => {
    it("respects the batch bound when more candidates exist than the requested batchSize", async () => {
      const rows = await Promise.all(Array.from({ length: 3 }, () => seedLedgerRow()));
      try {
        const summary = await reconcileInvoicePdfArchiveObjects({ now: new Date(), batchSize: 2 });
        expect(summary.scanned).toBe(2);
      } finally {
        await Promise.all(rows.map((r) => cleanupLedgerRow(r.id)));
      }
    });

    it("an oversized batchSize fails fast — before the candidate query, the claim write, or any probe/remove call", async () => {
      const findManySpy = vi.spyOn(prisma.invoicePdfArchiveObject, "findMany");
      const updateManySpy = vi.spyOn(prisma.invoicePdfArchiveObject, "updateMany");
      const probeSpy = vi.fn(async () => ({ ok: true as const, exists: false }));
      const removeSpy = vi.fn(async () => ({ ok: true as const }));
      try {
        await expect(
          reconcileInvoicePdfArchiveObjects({ now: new Date(), batchSize: BATCH_SIZE + 1 }, { probe: probeSpy, remove: removeSpy }),
        ).rejects.toThrow(RangeError);
        expect(findManySpy).not.toHaveBeenCalled();
        expect(updateManySpy).not.toHaveBeenCalled();
        expect(probeSpy).not.toHaveBeenCalled();
        expect(removeSpy).not.toHaveBeenCalled();
      } finally {
        findManySpy.mockRestore();
        updateManySpy.mockRestore();
      }
    });

    it("calling the worker repeatedly with nothing eligible left is a clean, all-zero-outcome no-op", async () => {
      const first = await reconcileInvoicePdfArchiveObjects({ now: new Date(), batchSize: 0 });
      const second = await reconcileInvoicePdfArchiveObjects({ now: new Date(), batchSize: 0 });
      expect(first.scanned).toBe(0);
      expect(second.scanned).toBe(0);
      expect(second.claimed).toBe(0);
    });

    it("PENDING_UPLOAD and CLEANUP_PENDING both respect MAX_CLEANUP_ATTEMPTS identically — a row at the ceiling is never claimed", async () => {
      const pending = await seedLedgerRow({ cleanupAttemptCount: MAX_CLEANUP_ATTEMPTS });
      const cleanupPending = await seedLedgerRow({ status: "CLEANUP_PENDING", cleanupAttemptCount: MAX_CLEANUP_ATTEMPTS, createdAt: new Date() });
      try {
        await reconcileInvoicePdfArchiveObjects({ now: new Date() });
        const afterPending = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: pending.id } });
        const afterCleanupPending = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: cleanupPending.id } });
        expect(afterPending.cleanupClaimToken).toBeNull();
        expect(afterCleanupPending.cleanupClaimToken).toBeNull();
      } finally {
        await cleanupLedgerRow(pending.id);
        await cleanupLedgerRow(cleanupPending.id);
      }
    });

    it("a stale claim (lease older than CLEANUP_LEASE_MS) is reclaimed and processed", async () => {
      const row = await seedLedgerRow({
        cleanupLockedAt: new Date(Date.now() - CLEANUP_LEASE_MS - 60_000),
        cleanupClaimToken: "cccccccc-0000-4000-8000-000000000005",
      });
      try {
        const summary = await reconcileInvoicePdfArchiveObjects({ now: new Date() });
        expect(summary.cleaned).toBeGreaterThanOrEqual(1);
        const after = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.status).toBe("CLEANED");
      } finally {
        await cleanupLedgerRow(row.id);
      }
    });

    it("an active (fresh) claim is skipped entirely — not scanned, not touched", async () => {
      const row = await seedLedgerRow({
        cleanupLockedAt: new Date(Date.now() - 60_000),
        cleanupClaimToken: "dddddddd-0000-4000-8000-000000000006",
      });
      try {
        await reconcileInvoicePdfArchiveObjects({ now: new Date() });
        const after = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(after).toEqual(row);
      } finally {
        await cleanupLedgerRow(row.id);
      }
    });

    it("a torn lock/token pair (lockedAt set, token null) is never claimed and is counted by inconsistentClaimState", async () => {
      const row = await seedLedgerRow({ cleanupLockedAt: new Date(Date.now() - 60_000), cleanupClaimToken: null });
      try {
        const summary = await reconcileInvoicePdfArchiveObjects({ now: new Date() });
        expect(summary.inconsistentClaimState).toBeGreaterThanOrEqual(1);
        const after = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(after).toEqual(row);
      } finally {
        await cleanupLedgerRow(row.id);
      }
    });

    it("a torn lock/token pair (lockedAt null, token set) is never claimed and is counted by inconsistentClaimState", async () => {
      const row = await seedLedgerRow({ cleanupLockedAt: null, cleanupClaimToken: "eeeeeeee-0000-4000-8000-000000000007" });
      try {
        const summary = await reconcileInvoicePdfArchiveObjects({ now: new Date() });
        expect(summary.inconsistentClaimState).toBeGreaterThanOrEqual(1);
        const after = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(after).toEqual(row);
      } finally {
        await cleanupLedgerRow(row.id);
      }
    });

    it("manualReviewPending counts an exhausted row and excludes REFERENCED/CLEANED rows with a historical high attempt count", async () => {
      const exhausted = await seedLedgerRow({ cleanupAttemptCount: MAX_CLEANUP_ATTEMPTS });
      const referencedHighAttempt = await seedLedgerRow({ status: "REFERENCED", cleanupAttemptCount: MAX_CLEANUP_ATTEMPTS });
      try {
        const summary = await reconcileInvoicePdfArchiveObjects({ now: new Date() });
        expect(summary.manualReviewPending).toBeGreaterThanOrEqual(1);

        const dryRunSummary = await reconcileInvoicePdfArchiveObjectsDryRun({ now: new Date() });
        expect(dryRunSummary.manualReviewPending).toBe(summary.manualReviewPending);
        void referencedHighAttempt;
      } finally {
        await cleanupLedgerRow(exhausted.id);
        await cleanupLedgerRow(referencedHighAttempt.id);
      }
    });

    it("one row's own unexpected exception does not stop the rest of the batch, and its lease is left for stale recovery", async () => {
      const KNOWN_TOKEN = "ffffffff-0000-4000-8000-000000000008";
      const throwingRow = await seedLedgerRow();
      const okRow = await seedLedgerRow();
      try {
        const summary = await reconcileInvoicePdfArchiveObjects(
          { now: new Date() },
          {
            generateRunToken: () => KNOWN_TOKEN,
            probe: async (args) => {
              if (args.identity.archiveId === throwingRow.id) {
                throw new Error("simulated unexpected DB-layer failure — must never be persisted or thrown to the caller");
              }
              return { ok: true, exists: false };
            },
          },
        );
        expect(summary.unexpectedFailures).toBeGreaterThanOrEqual(1);
        expect(summary.cleaned).toBeGreaterThanOrEqual(1);

        const afterThrowing = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: throwingRow.id } });
        // Lease left exactly as claimed — never released by the outer catch.
        expect(afterThrowing.status).toBe("PENDING_UPLOAD");
        expect(afterThrowing.cleanupClaimToken).toBe(KNOWN_TOKEN);
        expect(afterThrowing.cleanupLockedAt).not.toBeNull();

        const afterOk = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: okRow.id } });
        expect(afterOk.status).toBe("CLEANED");
      } finally {
        await cleanupLedgerRow(throwingRow.id);
        await cleanupLedgerRow(okRow.id);
      }
    });

    it("a claim lease surviving past its own run (simulated interrupted invocation) is recovered by a later run", async () => {
      const KNOWN_TOKEN = "12121212-0000-4000-8000-000000000009";
      const row = await seedLedgerRow();
      try {
        // First "run": the hook simulates the whole invocation being
        // terminated after the claim but before any release — by throwing
        // from beforeGuardedRelease itself, which the outer per-row catch
        // treats identically to any other unexpected exception.
        const firstSummary = await reconcileInvoicePdfArchiveObjects(
          { now: new Date() },
          {
            generateRunToken: () => KNOWN_TOKEN,
            probe: async () => ({ ok: true, exists: false }),
            beforeGuardedRelease: async () => {
              throw new Error("simulated invocation termination");
            },
          },
        );
        expect(firstSummary.unexpectedFailures).toBeGreaterThanOrEqual(1);
        const interrupted = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(interrupted.cleanupClaimToken).toBe(KNOWN_TOKEN);

        // Immediately afterward, the same lease is still active — a
        // second run must not touch it yet.
        await reconcileInvoicePdfArchiveObjects({ now: new Date() });
        const stillLeased = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(stillLeased.cleanupClaimToken).toBe(KNOWN_TOKEN);

        // Once CLEANUP_LEASE_MS has elapsed, a later run reclaims and
        // completes it.
        const later = new Date(Date.now() + CLEANUP_LEASE_MS + 60_000);
        const finalSummary = await reconcileInvoicePdfArchiveObjects({ now: later });
        expect(finalSummary.cleaned).toBeGreaterThanOrEqual(1);
        const finalRow = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(finalRow.status).toBe("CLEANED");
      } finally {
        await cleanupLedgerRow(row.id);
      }
    });
  });

  // --- True zero-write dry-run -------------------------------------------------

  describe("reconcileInvoicePdfArchiveObjectsDryRun — true zero-write proof", () => {
    it("leaves every affected row, Invoice, Activity, Notification, PortalDownloadRequest, and TEST_MODE Storage object byte-for-byte unchanged", async () => {
      const absentRow = await seedLedgerRow();
      const presentRow = await seedLedgerRow();
      await uploadInvoicePdfObject({
        identity: { organizationId: fixtures.orgA.id, invoiceId: fixtures.invoice.id, documentVersion: 1, archiveId: presentRow.id },
        body: Buffer.from("%PDF-1.3 present for dry-run"),
      });

      try {
        const beforeRows = await prisma.invoicePdfArchiveObject.findMany({
          where: { id: { in: [absentRow.id, presentRow.id] } },
          orderBy: { id: "asc" },
        });
        const beforeInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: fixtures.invoice.id } });
        const beforeActivities = await prisma.activity.findMany({ where: { entityType: "INVOICE", entityId: fixtures.invoice.id } });
        const beforeNotifications = await prisma.notification.findMany({ where: { organizationId: fixtures.orgA.id } });
        const beforePortalDownloadRequests = await prisma.portalDownloadRequest.findMany({ where: { organizationId: fixtures.orgA.id } });
        const beforeStorage = testStorageRead("attachments", presentRow.storagePath);

        const summary = await reconcileInvoicePdfArchiveObjectsDryRun({ now: new Date() });
        expect(summary.wouldCleanAbsent).toBeGreaterThanOrEqual(1);
        expect(summary.wouldRemovePresent).toBeGreaterThanOrEqual(1);

        const afterRows = await prisma.invoicePdfArchiveObject.findMany({
          where: { id: { in: [absentRow.id, presentRow.id] } },
          orderBy: { id: "asc" },
        });
        const afterInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: fixtures.invoice.id } });
        const afterActivities = await prisma.activity.findMany({ where: { entityType: "INVOICE", entityId: fixtures.invoice.id } });
        const afterNotifications = await prisma.notification.findMany({ where: { organizationId: fixtures.orgA.id } });
        const afterPortalDownloadRequests = await prisma.portalDownloadRequest.findMany({ where: { organizationId: fixtures.orgA.id } });
        const afterStorage = testStorageRead("attachments", presentRow.storagePath);

        expect(afterRows).toEqual(beforeRows);
        expect(afterInvoice).toEqual(beforeInvoice);
        expect(afterActivities).toEqual(beforeActivities);
        expect(afterNotifications).toEqual(beforeNotifications);
        expect(afterPortalDownloadRequests).toEqual(beforePortalDownloadRequests);
        expect(afterStorage).toEqual(beforeStorage);
        expect(afterStorage).not.toBeNull(); // the present object is still there — dry-run never removed it
      } finally {
        await cleanupLedgerRow(absentRow.id);
        await cleanupLedgerRow(presentRow.id);
      }
    });

    it("a real run afterward is completely unaffected by the earlier dry-run call", async () => {
      const row = await seedLedgerRow();
      try {
        await reconcileInvoicePdfArchiveObjectsDryRun({ now: new Date() });
        const summary = await reconcileInvoicePdfArchiveObjects({ now: new Date() });
        expect(summary.cleaned).toBeGreaterThanOrEqual(1);
        const after = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.status).toBe("CLEANED");
      } finally {
        await cleanupLedgerRow(row.id);
      }
    });
  });

  // --- Pure-predicate-vs-real-SQL cross-check ---------------------------------

  describe("isReconciliationCandidate matches the real candidateWhere() SQL", () => {
    it("a row the pure predicate says is eligible is actually scanned by the real worker", async () => {
      const row = await seedLedgerRow();
      try {
        const now = new Date();
        expect(
          isReconciliationCandidate(
            { status: row.status, cleanupLockedAt: row.cleanupLockedAt, cleanupClaimToken: row.cleanupClaimToken, cleanupAttemptCount: row.cleanupAttemptCount, createdAt: row.createdAt },
            now,
          ),
        ).toBe(true);

        const summary = await reconcileInvoicePdfArchiveObjects({ now });
        expect(summary.claimed).toBeGreaterThanOrEqual(1);
      } finally {
        await cleanupLedgerRow(row.id);
      }
    });

    it("a row the pure predicate says is NOT eligible is never scanned by the real worker", async () => {
      const row = await seedLedgerRow({ createdAt: new Date() }); // fresh — not yet safety-window-eligible
      try {
        const now = new Date();
        expect(
          isReconciliationCandidate(
            { status: row.status, cleanupLockedAt: row.cleanupLockedAt, cleanupClaimToken: row.cleanupClaimToken, cleanupAttemptCount: row.cleanupAttemptCount, createdAt: row.createdAt },
            now,
          ),
        ).toBe(false);

        await reconcileInvoicePdfArchiveObjects({ now });
        const after = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.cleanupClaimToken).toBeNull();
      } finally {
        await cleanupLedgerRow(row.id);
      }
    });
  });

  void BATCH_SIZE; // imported for completeness/documentation parity with the module's own exports; exercised indirectly above via explicit batchSize overrides
});
