import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron/auth";
import { checkRateLimit, CRON_JOB_LIMIT } from "@/lib/rate-limit";
import { reconcileInvoicePdfArchiveObjects, BATCH_SIZE } from "@/lib/invoices/pdf/reconcile-archive-objects";

// Never statically cached/optimized — this must actually run, every time
// an authorized caller hits it.
export const dynamic = "force-dynamic";

// Bounded Archival Reconciliation/Cleanup — each claimed row costs up to
// two real Storage network round trips with no caller-controlled timeout
// (see reconcile-archive-objects.ts's own BATCH_SIZE doc comment). 60
// seconds is a deliberate operational ceiling for this route specifically
// — unrelated to the 900-second bound reconcile-archive-objects.ts uses
// for its own stale-uploader safety proof (CLEANUP_LEASE_MS is asserted,
// at module load, to exceed this exact value).
export const maxDuration = 60;

/**
 * Vercel Cron, or a manual authorized call, sends a GET with
 * `Authorization: Bearer <CRON_SECRET>`. No session, Membership, or portal
 * cookie is ever read here — CRON_SECRET remains the complete auth
 * boundary, checked once via the shared helper before anything else runs.
 *
 * Now scheduled once daily in vercel.json. Activation followed a successful
 * authorized production dry-run, operator review of its result, and one
 * successful authorized manual invocation of this real route. Both of
 * those production summaries were all-zero, because no reconciliation
 * candidates existed at activation time — that exercise verified live
 * auth and routing end to end and the zero-candidate code path; it did not
 * exercise, and does not claim to have exercised, this route's write path
 * (claim/probe/remove/release) against a real candidate.
 */
export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  // Defense in depth only — CRON_SECRET is the real barrier. Bucketed by
  // this route's own fixed identifier, isolated from every other cron
  // job's own bucket (including this feature's own dry-run sibling).
  const limitCheck = checkRateLimit(CRON_JOB_LIMIT, "invoice-pdf-reconciliation");
  if (limitCheck.limited) {
    return NextResponse.json({ error: limitCheck.message }, { status: 429 });
  }

  const summary = await reconcileInvoicePdfArchiveObjects({ now: new Date(), batchSize: BATCH_SIZE });
  return NextResponse.json(summary);
}
