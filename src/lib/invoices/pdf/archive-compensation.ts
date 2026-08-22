import "server-only";
import { prisma } from "@/lib/prisma";
import type { InvoicePdfObjectIdentity, InvoicePdfRemoveResult } from "./storage";

/**
 * Invoice System Official Slice 3, Legacy Archive — extracted from
 * issue-invoice.ts's own private compensateUpload() (sub-PR 3b), unchanged
 * in behavior. Shared by both issue-invoice.ts and legacy-archive-
 * invoice.ts, since both pipelines need the exact same best-effort
 * response to "a PDF object was successfully uploaded but never got
 * referenced by a committed Invoice." Deliberately depends on nothing
 * pipeline-specific (no email, no snapshot, no calculation type) — only
 * what compensating a single uploaded-but-unreferenced Storage object
 * genuinely requires.
 *
 * Runs OUTSIDE any DB transaction, after either an upload-ambiguous-
 * failure or a failed final transaction. Never deletes the ledger row
 * outright; only ever advances its status. If even the status update
 * fails, the row is left exactly as it was (PENDING_UPLOAD), which is
 * itself still a safe, discoverable state for the future reconciliation
 * worker (not implemented by this module or by either caller).
 */
export type ArchiveCompensationDeps = {
  remove: (args: { identity: InvoicePdfObjectIdentity }) => Promise<InvoicePdfRemoveResult>;
};

export async function compensateArchiveUpload(
  deps: ArchiveCompensationDeps,
  ledgerId: string,
  identity: InvoicePdfObjectIdentity,
  now: Date,
): Promise<void> {
  let removal: InvoicePdfRemoveResult;
  try {
    removal = await deps.remove({ identity });
  } catch {
    // A rejected/thrown removal is converted to the same bounded
    // "remove_failed" category an ordinary unsuccessful removal already
    // uses — the raw exception is never persisted and never allowed to
    // escape compensation, which is always best-effort.
    removal = { ok: false, reason: "remove_failed" };
  }

  try {
    if (removal.ok) {
      // Bounded Archival Reconciliation/Cleanup — cleanupLockedAt/
      // cleanupClaimToken must both be null: a row the reconciliation
      // worker currently holds claimed must never be overwritten by this
      // producer-triggered compensation path. If a claim is active, this
      // update matches zero rows and the row is left exactly as
      // reconciliation itself owns it.
      await prisma.invoicePdfArchiveObject.updateMany({
        where: { id: ledgerId, status: "PENDING_UPLOAD", cleanupLockedAt: null, cleanupClaimToken: null },
        data: { status: "CLEANED", cleanedAt: now },
      });
    } else {
      await prisma.invoicePdfArchiveObject.updateMany({
        where: { id: ledgerId, status: "PENDING_UPLOAD", cleanupLockedAt: null, cleanupClaimToken: null },
        data: {
          status: "CLEANUP_PENDING",
          cleanupAttemptCount: { increment: 1 },
          lastCleanupFailureCategory: removal.reason,
        },
      });
    }
  } catch {
    // The ledger row stays PENDING_UPLOAD — still a safe, discoverable
    // state; never re-thrown, since compensation is always best-effort.
  }
}
