import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import {
  buildInvoicePdfStoragePath,
  probeInvoicePdfObject,
  removeInvoicePdfObject,
  type InvoicePdfObjectIdentity,
  type InvoicePdfRemoveResult,
} from "./storage";

/**
 * Bounded Archival Reconciliation/Cleanup — the bounded, ledger-driven
 * worker for archive-compensation.ts's own documented residual: a
 * PENDING_UPLOAD row that never reached a terminal state (its own states
 * B/D/crash) because either the compensating ledger transition itself
 * failed, or the producing process crashed before compensation ever ran.
 * Also retries a CLEANUP_PENDING row whose earlier compensating removal
 * failed.
 *
 * Never lists or scans the Storage bucket — every candidate comes from a
 * bounded InvoicePdfArchiveObject query; each row's own exact object is
 * addressed individually via probeInvoicePdfObject()/removeInvoicePdfObject(),
 * never a directory/prefix operation. This supersedes
 * docs/invoicing-architecture.md §8.5's original "list private Storage
 * objects... compare against every Invoice.pdfStoragePath" design, written
 * before the InvoicePdfArchiveObject ledger existed — §8.5's own normative
 * goals (idempotent, tenant-safe, orphan removed/referenced-untouched,
 * safety-window, idempotent-rerun) remain valid; only the mechanism
 * changed.
 */

// --- Constants -------------------------------------------------------------

/**
 * A PENDING_UPLOAD row younger than this is never a reconciliation
 * candidate — it may still be a genuinely in-flight Issue/Legacy Archive
 * attempt. Chosen to structurally exceed MAX_VERCEL_FUNCTION_DURATION_MS
 * below — see that constant's own doc comment for the full proof this
 * relationship establishes.
 */
export const SAFETY_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/**
 * How long a claim (cleanupLockedAt/cleanupClaimToken) may be held before
 * a later run treats it as abandoned by a crashed worker and reclaims it.
 * Mirrors this codebase's own existing retryNotificationDeliveries()'s own
 * STALE_LOCK_MS exactly (10 minutes) — the identical crash-safe-claim
 * problem shape, no reason to diverge.
 */
export const CLEANUP_LEASE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * A conservative STARTING bound, not a timing guarantee. Each row costs up
 * to two real network round trips to Storage (probe, then optionally
 * remove) — the installed @supabase/storage-js's own exists()/remove()
 * offer no caller-controlled timeout (verified directly against the
 * installed source), so a single call can in principle consume the whole
 * invocation. maxDuration=60 (declared literally on both reconciliation
 * routes) bounds the invocation's own platform-enforced lifetime, never
 * any individual Storage call's duration — completing all BATCH_SIZE rows
 * in one run is NOT guaranteed. Rows that do reach their own guarded
 * release write before any termination remain safely, atomically
 * committed (each row's release is one independent updateMany); a row
 * whose processing is interrupted because the whole invocation is killed
 * remains claimed under that run's own token and is recovered by a later
 * run once CLEANUP_LEASE_MS elapses — the same mechanism that already
 * recovers a genuinely crashed producer. 25 is chosen because real-world
 * orphan volume is expected to be low (a failure-path artifact, not a
 * steady-state event); future production evidence may justify raising or
 * lowering it.
 */
export const BATCH_SIZE = 25;

/**
 * Once a row's own cleanupAttemptCount reaches this ceiling, it is
 * excluded from every future candidate query — never a new terminal
 * status (see countManualReviewPending() below) — until an operator
 * resolves it directly. At the once-daily cron cadence this app's other
 * two cron jobs already use, 20 attempts is roughly 20 days of persistent
 * failure before a row stops auto-retrying — ample time for a transient
 * issue to self-resolve, bounded enough that a permanently broken
 * configuration doesn't retry forever.
 */
export const MAX_CLEANUP_ATTEMPTS = 20;

/**
 * The conservative documented upper bound across every current Vercel
 * Function execution-duration configuration (Fluid Compute: Hobby 300s,
 * Pro/Enterprise 800s; non-Fluid/legacy: Hobby 60s, Pro 300s, Enterprise
 * 900s — https://vercel.com/docs/functions/configuring-functions/duration,
 * verified 2026-08-20). Used ONLY for the assertion immediately below —
 * never to configure either reconciliation route's own maxDuration (both
 * routes instead declare a literal maxDuration=60, an operational choice
 * unrelated to this proof).
 *
 * issueInvoice()/archiveLegacyInvoice() each execute synchronously inside
 * one Vercel Function invocation. No documented configuration allows a
 * single invocation to exceed this bound, and a terminated serverless
 * invocation does not pause and later resume — termination is final, and a
 * genuinely new attempt always uses a fresh archiveId/path (see
 * issue-invoice.ts's own "a fresh unique archive id" comment), never the
 * old, now-abandoned row. Because SAFETY_WINDOW_MS exceeds this bound, the
 * single production invocation that created a given PENDING_UPLOAD row is
 * therefore structurally guaranteed to have already terminated by the time
 * that row can ever become reconciliation-eligible. The pre-upload
 * ownership recheck in issue-invoice.ts/legacy-archive-invoice.ts is
 * additional defense in depth, not the primary proof.
 *
 * PORTABILITY: this proof is specific to this application's current Vercel
 * deployment. If the application is ever deployed off Vercel, or Vercel
 * raises any tier's ceiling beyond SAFETY_WINDOW_MS, this invariant must be
 * re-derived against the new platform's own actual maximum invocation
 * lifetime before SAFETY_WINDOW_MS can be trusted again.
 */
export const MAX_VERCEL_FUNCTION_DURATION_MS = 15 * 60 * 1000; // 900,000ms

if (SAFETY_WINDOW_MS <= MAX_VERCEL_FUNCTION_DURATION_MS) {
  throw new Error("SAFETY_WINDOW_MS must exceed MAX_VERCEL_FUNCTION_DURATION_MS — see this module's own doc comment.");
}

/**
 * Both reconciliation routes declare a literal maxDuration=60 (60 seconds).
 * CLEANUP_LEASE_MS must exceed that configured route lifetime — otherwise
 * a still-live route invocation (one that has not yet reached its own
 * final release write, e.g. mid-way through a slow Storage call) could
 * become "stale claim eligible" to a second, concurrent invocation before
 * the platform has even had a chance to terminate the first one.
 */
const RECONCILIATION_ROUTE_MAX_DURATION_SECONDS = 60;
if (CLEANUP_LEASE_MS <= RECONCILIATION_ROUTE_MAX_DURATION_SECONDS * 1000) {
  throw new Error(
    "CLEANUP_LEASE_MS must exceed the reconciliation routes' own configured maxDuration (60s) — see this module's own doc comment.",
  );
}

const RECONCILABLE_STATUSES = ["PENDING_UPLOAD", "CLEANUP_PENDING"] as const;

/**
 * The single resolver both exported workers use to turn an optional
 * caller-supplied params.batchSize into the exact value passed to Prisma's
 * own `take` — the only path either worker ever reads params.batchSize
 * through. Deliberately never clamps: a value outside the closed
 * [0, BATCH_SIZE] contract is a programmer error in whatever internal
 * caller supplied it, not a value to silently coerce into range — clamping
 * would hide that bug instead of surfacing it. Always called first, before
 * either worker makes any Prisma or Storage call.
 */
export function resolveBatchSize(value: number | undefined): number {
  if (value === undefined) return BATCH_SIZE;
  if (!Number.isInteger(value) || value < 0 || value > BATCH_SIZE) {
    throw new RangeError(`batchSize must be an integer from 0 through ${BATCH_SIZE} inclusive, received ${value}`);
  }
  return value;
}

// --- Candidate eligibility ---------------------------------------------------

/**
 * The single shared eligibility predicate — used, unmodified, by the real
 * worker's own candidate SELECT, its claim UPDATE (nested inside an
 * additional `id IN (...)` predicate, re-proving the entire predicate
 * atomically and closing the selection-to-claim gap), and the dry-run
 * worker's own SELECT. Deliberately never used by the post-claim requery
 * (see reconcileInvoicePdfArchiveObjects()'s own comment on why that would
 * be actively wrong) or by any release helper.
 */
function candidateWhere(now: Date): Prisma.InvoicePdfArchiveObjectWhereInput {
  const staleClaimThreshold = new Date(now.getTime() - CLEANUP_LEASE_MS);
  const safetyThreshold = new Date(now.getTime() - SAFETY_WINDOW_MS);

  return {
    AND: [
      {
        // Torn pairs (exactly one of the two fields null) match neither
        // branch below and are therefore never claimed — never
        // auto-healed. See countInconsistentClaimState() for the
        // diagnostic that surfaces them instead.
        OR: [
          { cleanupLockedAt: null, cleanupClaimToken: null },
          { cleanupLockedAt: { lt: staleClaimThreshold }, cleanupClaimToken: { not: null } },
        ],
      },
      {
        OR: [
          { status: "CLEANUP_PENDING", cleanupAttemptCount: { lt: MAX_CLEANUP_ATTEMPTS } },
          {
            status: "PENDING_UPLOAD",
            createdAt: { lt: safetyThreshold },
            cleanupAttemptCount: { lt: MAX_CLEANUP_ATTEMPTS },
          },
        ],
      },
    ],
  };
}

export type ReconciliationCandidateRow = {
  status: "PENDING_UPLOAD" | "CLEANUP_PENDING" | "REFERENCED" | "CLEANED";
  cleanupLockedAt: Date | null;
  cleanupClaimToken: string | null;
  cleanupAttemptCount: number;
  createdAt: Date;
};

/**
 * The eligibility predicate's spec, as a pure function — mirrors
 * candidateWhere()'s own Prisma WHERE clause exactly (Prisma cannot call a
 * JS predicate mid-query, the same reasoning this codebase's own
 * retryNotificationDeliveries.ts's own isEligibleForRetryClaim() already
 * documents), so this function is what that WHERE clause is directly
 * unit-tested against, and what an integration test proves the real SQL
 * actually matches. Strict inequalities throughout: a row exactly at a
 * threshold is NOT yet eligible; one millisecond past it is.
 */
export function isReconciliationCandidate(
  row: ReconciliationCandidateRow,
  now: Date,
  safetyWindowMs: number = SAFETY_WINDOW_MS,
  cleanupLeaseMs: number = CLEANUP_LEASE_MS,
  maxAttempts: number = MAX_CLEANUP_ATTEMPTS,
): boolean {
  const claimEligible =
    (row.cleanupLockedAt === null && row.cleanupClaimToken === null) ||
    (row.cleanupLockedAt !== null &&
      row.cleanupClaimToken !== null &&
      now.getTime() - row.cleanupLockedAt.getTime() > cleanupLeaseMs);
  // A torn pair (exactly one of the two fields null) satisfies neither
  // branch above — never auto-healed, never claimed.
  if (!claimEligible) return false;

  if (row.status === "CLEANUP_PENDING") {
    return row.cleanupAttemptCount < maxAttempts;
  }
  if (row.status === "PENDING_UPLOAD") {
    return row.cleanupAttemptCount < maxAttempts && now.getTime() - row.createdAt.getTime() > safetyWindowMs;
  }
  return false; // REFERENCED, CLEANED — never candidates.
}

// --- Path parsing / identity recovery ---------------------------------------

const CANONICAL_PATH_PATTERN =
  /^organizations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/invoice-pdf\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/v(\d+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pdf$/i;

export type ParsedArchiveObjectPath =
  | { ok: true; identity: InvoicePdfObjectIdentity }
  | {
      ok: false;
      reason:
        | "malformed"
        | "organization_mismatch"
        | "archive_id_mismatch"
        | "document_version_mismatch"
        | "invoice_id_mismatch"
        | "round_trip_mismatch";
    };

export type ArchiveObjectLedgerRow = {
  id: string;
  organizationId: string;
  invoiceId: string | null;
  documentVersion: number;
  storagePath: string;
};

/**
 * Recovers a structured InvoicePdfObjectIdentity from a ledger row's own
 * immutable storagePath — required because InvoicePdfObjectIdentity
 * requires a non-null invoiceId, but InvoicePdfArchiveObject.invoiceId is
 * nullable (SetNull when its source DRAFT Invoice is deleted). storagePath
 * itself is set once at row creation and never updated afterward by any
 * caller (verified directly — no `data:` block anywhere in
 * issue-invoice.ts, legacy-archive-invoice.ts, or archive-compensation.ts
 * includes storagePath), so it remains a permanently reliable record of
 * the original invoiceId even after the relational column is later
 * cleared.
 *
 * Every extracted component is cross-checked against the row's own
 * authoritative, non-nullable fields (organizationId, id, documentVersion,
 * and — when it is itself non-null — invoiceId), and the recovered
 * identity must round-trip through buildInvoicePdfStoragePath() back to
 * the exact original storagePath — the same canonical-rebuild-and-compare
 * idiom both PDF GET routes already use. No migration, no new column: this
 * function is the sole source of truth for recovering identity from a
 * ledger row whose invoiceId may already be null. The fixed "invoice-pdf"
 * namespace segment structurally excludes any Attachment or logo path.
 */
export function parseAndValidateArchiveObjectPath(row: ArchiveObjectLedgerRow): ParsedArchiveObjectPath {
  const match = row.storagePath.match(CANONICAL_PATH_PATTERN);
  if (!match) return { ok: false, reason: "malformed" };
  const [, orgSegment, invoiceSegment, versionSegment, archiveSegment] = match;

  if (orgSegment.toLowerCase() !== row.organizationId.toLowerCase()) {
    return { ok: false, reason: "organization_mismatch" };
  }
  if (archiveSegment.toLowerCase() !== row.id.toLowerCase()) {
    return { ok: false, reason: "archive_id_mismatch" };
  }

  const parsedVersion = Number(versionSegment);
  if (!Number.isSafeInteger(parsedVersion) || parsedVersion < 1 || parsedVersion !== row.documentVersion) {
    return { ok: false, reason: "document_version_mismatch" };
  }

  if (row.invoiceId !== null && invoiceSegment.toLowerCase() !== row.invoiceId.toLowerCase()) {
    return { ok: false, reason: "invoice_id_mismatch" };
  }

  const identity: InvoicePdfObjectIdentity = {
    organizationId: row.organizationId,
    invoiceId: invoiceSegment,
    documentVersion: row.documentVersion,
    archiveId: row.id,
  };

  let rebuilt: string;
  try {
    rebuilt = buildInvoicePdfStoragePath(identity);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (rebuilt !== row.storagePath) return { ok: false, reason: "round_trip_mismatch" };

  return { ok: true, identity };
}

// --- Failure categories / dependency injection ------------------------------

/**
 * The one closed set of values ever persisted to
 * InvoicePdfArchiveObject.lastCleanupFailureCategory by this module. Never
 * a raw provider error, response body, path, signed URL, tenant id, or
 * Invoice id/number.
 */
export type ReconciliationFailureCategory =
  | "storage_not_configured"
  | "probe_failed"
  | "remove_failed"
  | "invariant_violation"
  | "invoice_reference_detected";

export type ReconciliationDeps = {
  generateRunToken: () => string;
  probe: typeof probeInvoicePdfObject;
  remove: typeof removeInvoicePdfObject;
  /**
   * Internal-only test hook — never exposed through any route, environment
   * flag, request, or public UI. Called at most once per claimed row, and
   * only when that row actually reaches a guarded release attempt (zero
   * calls if an unexpected exception aborts the row's processing before a
   * release decision is made). Fires after the row's complete outcome has
   * been decided — if a removal was required, only after remove() has
   * already returned — immediately before the corresponding guarded
   * release write. Never called between the second Invoice-reference check
   * and remove(); nothing runs in that window, in production or in any
   * test. Production default is a no-op. If this hook throws, the row's
   * own outer per-row catch treats it exactly like any other unexpected
   * exception: unexpectedFailures increments and the lease is left held
   * for later stale-claim recovery.
   */
  beforeGuardedRelease: (rowId: string) => Promise<void> | void;
};

const defaultDeps: ReconciliationDeps = {
  generateRunToken: () => randomUUID(),
  probe: probeInvoicePdfObject,
  remove: removeInvoicePdfObject,
  beforeGuardedRelease: () => {},
};

// --- Summaries ---------------------------------------------------------------

export type ReconciliationSummary = {
  scanned: number;
  claimed: number;
  cleaned: number;
  retained: number;
  releasedWithFailure: number;
  claimLost: number;
  unexpectedFailures: number;
  manualReviewPending: number;
  inconsistentClaimState: number;
};

function emptyReconciliationSummary(): ReconciliationSummary {
  return {
    scanned: 0,
    claimed: 0,
    cleaned: 0,
    retained: 0,
    releasedWithFailure: 0,
    claimLost: 0,
    unexpectedFailures: 0,
    manualReviewPending: 0,
    inconsistentClaimState: 0,
  };
}

export type ReconciliationDryRunSummary = {
  scanned: number;
  wouldCleanAbsent: number;
  wouldRemovePresent: number;
  wouldRetryProbeFailure: number;
  wouldSkipInvariant: number;
  manualReviewPending: number;
  inconsistentClaimState: number;
};

function emptyDryRunSummary(): ReconciliationDryRunSummary {
  return {
    scanned: 0,
    wouldCleanAbsent: 0,
    wouldRemovePresent: 0,
    wouldRetryProbeFailure: 0,
    wouldSkipInvariant: 0,
    manualReviewPending: 0,
    inconsistentClaimState: 0,
  };
}

// --- Diagnostics (pure reads, safe in both the real and dry-run summaries) --

async function countManualReviewPending(): Promise<number> {
  return prisma.invoicePdfArchiveObject.count({
    where: { status: { in: [...RECONCILABLE_STATUSES] }, cleanupAttemptCount: { gte: MAX_CLEANUP_ATTEMPTS } },
  });
}

async function countInconsistentClaimState(): Promise<number> {
  return prisma.invoicePdfArchiveObject.count({
    where: {
      status: { in: [...RECONCILABLE_STATUSES] },
      OR: [
        { cleanupLockedAt: null, cleanupClaimToken: { not: null } },
        { cleanupLockedAt: { not: null }, cleanupClaimToken: null },
      ],
    },
  });
}

// --- Release helpers (module-private — testability is via ReconciliationDeps
// injection into the exported worker, mirroring IssueInvoiceDeps/
// LegacyArchiveDeps's own established convention, never a new low-level
// export) ---------------------------------------------------------------------

/**
 * Every release helper requires id + cleanupClaimToken=runToken +
 * status IN (PENDING_UPLOAD, CLEANUP_PENDING) — never cleanupLockedAt
 * equality. cleanupClaimToken is a fresh, cryptographically-random UUID
 * per invocation; no other process ever writes this exact value, so token
 * equality alone is sufficient proof of ownership. cleanupLockedAt is
 * always written together with cleanupClaimToken by the claim step and
 * cleared together with it by every release helper — after the producer/
 * compensation guard fixes above, no other writer ever touches either
 * field on a row this worker currently owns — so if cleanupClaimToken
 * matches, cleanupLockedAt is structurally guaranteed non-null too; an
 * additional equality check on it would filter nothing the token check
 * doesn't already filter, and would be fragile against DateTime(3)
 * serialization precision. The status restriction independently prevents
 * mutating a REFERENCED or CLEANED row even if a token were somehow
 * (impossibly) reused.
 */
async function releaseAsCleaned(rowId: string, runToken: string, now: Date) {
  return prisma.invoicePdfArchiveObject.updateMany({
    where: { id: rowId, cleanupClaimToken: runToken, status: { in: [...RECONCILABLE_STATUSES] } },
    data: { status: "CLEANED", cleanedAt: now, cleanupLockedAt: null, cleanupClaimToken: null },
  });
}

async function releaseAsCleanupPending(rowId: string, runToken: string) {
  return prisma.invoicePdfArchiveObject.updateMany({
    where: { id: rowId, cleanupClaimToken: runToken, status: { in: [...RECONCILABLE_STATUSES] } },
    data: {
      status: "CLEANUP_PENDING",
      cleanupAttemptCount: { increment: 1 },
      lastCleanupFailureCategory: "remove_failed",
      cleanupLockedAt: null,
      cleanupClaimToken: null,
    },
  });
}

/** Records a guarded release call's outcome: count:0 always means claimLost, regardless of which release helper produced it. */
function recordReleaseOutcome(
  summary: ReconciliationSummary,
  result: { count: number },
  onSuccess: "cleaned" | "retained" | "releasedWithFailure",
): void {
  if (result.count === 0) {
    summary.claimLost++;
  } else {
    summary[onSuccess]++;
  }
}

async function releaseWithFailure(rowId: string, runToken: string, category: ReconciliationFailureCategory) {
  return prisma.invoicePdfArchiveObject.updateMany({
    where: { id: rowId, cleanupClaimToken: runToken, status: { in: [...RECONCILABLE_STATUSES] } },
    data: {
      // status deliberately omitted — never changed by a non-confirmed outcome.
      cleanupAttemptCount: { increment: 1 },
      lastCleanupFailureCategory: category,
      cleanupLockedAt: null,
      cleanupClaimToken: null,
    },
  });
}

// --- Real worker ---------------------------------------------------------------

/**
 * The authoritative, claim-based, write-capable reconciliation worker.
 * Meant to be called from the cron-triggered `/api/cron/invoice-pdf-
 * reconciliation` Route Handler, never from user request handling —
 * `params.now` is caller-supplied so every run (and every test) is
 * deterministic, and there is no session/Membership/cookie dependency of
 * any kind.
 */
export async function reconcileInvoicePdfArchiveObjects(
  params: { now: Date; batchSize?: number },
  overrides: Partial<ReconciliationDeps> = {},
): Promise<ReconciliationSummary> {
  const batchSize = resolveBatchSize(params.batchSize);
  const deps: ReconciliationDeps = { ...defaultDeps, ...overrides };
  const now = params.now;
  const summary = emptyReconciliationSummary();

  // One fresh, cryptographically-random token — the sole ownership key for
  // this invocation.
  const runToken = deps.generateRunToken();

  const candidates = await prisma.invoicePdfArchiveObject.findMany({
    where: candidateWhere(now),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: batchSize,
    select: { id: true },
  });
  summary.scanned = candidates.length;
  const candidateIds = candidates.map((c) => c.id);

  if (candidateIds.length === 0) {
    summary.manualReviewPending = await countManualReviewPending();
    summary.inconsistentClaimState = await countInconsistentClaimState();
    return summary;
  }

  // Atomic claim — re-proves the FULL eligibility predicate atomically,
  // closing the selection-to-claim gap: a row that transitioned away from
  // eligibility (e.g. a live producer finalized it to REFERENCED) between
  // the SELECT above and this UPDATE simply fails to match and is not
  // claimed.
  await prisma.invoicePdfArchiveObject.updateMany({
    where: { AND: [{ id: { in: candidateIds } }, candidateWhere(now)] },
    data: { cleanupLockedAt: now, cleanupClaimToken: runToken },
  });

  // Post-claim requery — deliberately does NOT call candidateWhere() again.
  // A row this run just claimed now has cleanupLockedAt=now and a non-null
  // cleanupClaimToken, which can satisfy neither candidateWhere()'s
  // "unclaimed" branch (token isn't null) nor its "stale" branch
  // (cleanupLockedAt is not older than the stale threshold — it IS `now`)
  // — reapplying candidateWhere() here would make this worker claim rows
  // and then find zero of them. Ownership is proven by cleanupClaimToken
  // alone; status is additionally restricted as defense in depth. No
  // cleanupLockedAt equality check (see the release-helper comment above
  // for why).
  const claimed = await prisma.invoicePdfArchiveObject.findMany({
    where: { id: { in: candidateIds }, cleanupClaimToken: runToken, status: { in: [...RECONCILABLE_STATUSES] } },
    select: { id: true, organizationId: true, invoiceId: true, documentVersion: true, storagePath: true },
  });
  summary.claimed = claimed.length;

  for (const row of claimed) {
    try {
      // First Invoice-reference check — cheap, indexed
      // (Invoice.pdfStoragePath is @unique), no I/O beyond one query.
      const referenced = await prisma.invoice.findFirst({
        where: { pdfStoragePath: row.storagePath },
        select: { id: true },
      });
      if (referenced) {
        await deps.beforeGuardedRelease(row.id);
        const r = await releaseWithFailure(row.id, runToken, "invoice_reference_detected");
        recordReleaseOutcome(summary, r, "releasedWithFailure");
        continue;
      }

      const parsed = parseAndValidateArchiveObjectPath(row);
      if (!parsed.ok) {
        await deps.beforeGuardedRelease(row.id);
        const r = await releaseWithFailure(row.id, runToken, "invariant_violation");
        recordReleaseOutcome(summary, r, "releasedWithFailure");
        continue;
      }

      const probeResult = await deps.probe({ identity: parsed.identity });
      if (!probeResult.ok) {
        await deps.beforeGuardedRelease(row.id);
        const r = await releaseWithFailure(row.id, runToken, probeResult.reason);
        recordReleaseOutcome(summary, r, "releasedWithFailure");
        continue;
      }

      if (!probeResult.exists) {
        // Second Invoice-reference check, immediately before the terminal
        // absent -> CLEANED release. Defense in depth — structurally
        // unreachable while this worker holds an active claim, given the
        // producer/compensation guard fixes above, kept anyway.
        const stillUnreferenced = !(await prisma.invoice.findFirst({
          where: { pdfStoragePath: row.storagePath },
          select: { id: true },
        }));
        if (!stillUnreferenced) {
          await deps.beforeGuardedRelease(row.id);
          const r = await releaseWithFailure(row.id, runToken, "invoice_reference_detected");
          recordReleaseOutcome(summary, r, "releasedWithFailure");
          continue;
        }
        await deps.beforeGuardedRelease(row.id);
        const r = await releaseAsCleaned(row.id, runToken, now);
        recordReleaseOutcome(summary, r, "cleaned");
        continue;
      }

      // Object present — second reference check, then remove(). No hook
      // call runs between this check and remove() — nothing may.
      const stillUnreferenced = !(await prisma.invoice.findFirst({
        where: { pdfStoragePath: row.storagePath },
        select: { id: true },
      }));
      if (!stillUnreferenced) {
        await deps.beforeGuardedRelease(row.id);
        const r = await releaseWithFailure(row.id, runToken, "invoice_reference_detected");
        recordReleaseOutcome(summary, r, "releasedWithFailure");
        continue;
      }

      const removal: InvoicePdfRemoveResult = await deps.remove({ identity: parsed.identity });
      // Hook fires ONLY after remove() has returned, immediately before
      // whichever release call follows.
      await deps.beforeGuardedRelease(row.id);
      if (removal.ok) {
        const r = await releaseAsCleaned(row.id, runToken, now);
        recordReleaseOutcome(summary, r, "cleaned");
      } else if (removal.reason === "remove_failed") {
        const r = await releaseAsCleanupPending(row.id, runToken);
        recordReleaseOutcome(summary, r, "retained");
      } else {
        // removal.reason === "storage_not_configured" — status
        // deliberately unchanged (never CLEANUP_PENDING); Storage being
        // entirely unreachable says nothing about whether removal would
        // actually succeed.
        const r = await releaseWithFailure(row.id, runToken, "storage_not_configured");
        recordReleaseOutcome(summary, r, "releasedWithFailure");
      }
    } catch {
      // A genuine unexpected exception (e.g. a DB-layer failure on one of
      // the plain reads/writes above, or a thrown beforeGuardedRelease
      // test hook) — attempting another guarded write here is likely to
      // fail identically or mask the real problem. The lease is left
      // exactly as claimed; a later run's own stale-claim branch of
      // candidateWhere() recovers it once CLEANUP_LEASE_MS elapses. Every
      // other row in this batch still gets processed while this JS
      // invocation remains alive.
      summary.unexpectedFailures++;
      continue;
    }
  }

  summary.manualReviewPending = await countManualReviewPending();
  summary.inconsistentClaimState = await countInconsistentClaimState();
  return summary;
}

// --- Dry-run worker (true zero-write) -------------------------------------

/**
 * A genuinely read-only preview of what reconcileInvoicePdfArchiveObjects()
 * would do. Performs zero Prisma writes and zero Storage writes: no claim,
 * no release, no status/attempt/category/updatedAt change, and
 * removeInvoicePdfObject() is never called. Results are advisory snapshots
 * — a row reported here could legitimately be claimed and modified by the
 * real worker or a live producer moments later. This is fully acceptable
 * precisely because this function never writes anything; there is nothing
 * for a subsequent write to corrupt, and no ownership guarantee is claimed
 * or needed.
 */
export async function reconcileInvoicePdfArchiveObjectsDryRun(
  params: { now: Date; batchSize?: number },
  overrides: Partial<Pick<ReconciliationDeps, "probe">> = {},
): Promise<ReconciliationDryRunSummary> {
  const batchSize = resolveBatchSize(params.batchSize);
  const probe = overrides.probe ?? probeInvoicePdfObject;
  const summary = emptyDryRunSummary();

  const candidates = await prisma.invoicePdfArchiveObject.findMany({
    where: candidateWhere(params.now),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: batchSize,
    select: { id: true, organizationId: true, invoiceId: true, documentVersion: true, storagePath: true },
  });
  summary.scanned = candidates.length;

  for (const row of candidates) {
    const referenced = await prisma.invoice.findFirst({
      where: { pdfStoragePath: row.storagePath },
      select: { id: true },
    });
    if (referenced) {
      summary.wouldSkipInvariant++;
      continue;
    }

    const parsed = parseAndValidateArchiveObjectPath(row);
    if (!parsed.ok) {
      summary.wouldSkipInvariant++;
      continue;
    }

    const probeResult = await probe({ identity: parsed.identity }); // read-only network call — never a write
    if (!probeResult.ok) {
      summary.wouldRetryProbeFailure++;
      continue;
    }
    if (!probeResult.exists) {
      summary.wouldCleanAbsent++;
      continue;
    }
    // Object present — a real run would attempt removal here.
    // removeInvoicePdfObject() is NEVER called by this function; the
    // outcome of a hypothetical removal is never predicted.
    summary.wouldRemovePresent++;
  }

  summary.manualReviewPending = await countManualReviewPending();
  summary.inconsistentClaimState = await countInconsistentClaimState();
  return summary;
}
