import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron/auth";
import { checkRateLimit, CRON_JOB_LIMIT } from "@/lib/rate-limit";
import { reconcileInvoicePdfArchiveObjectsDryRun, BATCH_SIZE } from "@/lib/invoices/pdf/reconcile-archive-objects";

export const dynamic = "force-dynamic";

// Same operational ceiling as the real route's own maxDuration — this
// route's own per-row cost (a read-only probe) is comparable, just without
// the conditional remove() call.
export const maxDuration = 60;

/**
 * A genuinely read-only preview of the real reconciliation route's sibling
 * above — performs zero Prisma writes and zero Storage writes (see
 * reconcileInvoicePdfArchiveObjectsDryRun()'s own doc comment). A distinct
 * URL path rather than a query-string flag on the real route, deliberately
 * — check-cron-security.mjs's own existing check bans any cron route from
 * reading a query string at all, and a distinct, explicit path is more
 * auditable than a hidden parameter. Never added to vercel.json's own
 * schedule, ever — this route exists solely for manual, authorized,
 * pre-activation verification, never for a recurring trigger.
 */
export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const limitCheck = checkRateLimit(CRON_JOB_LIMIT, "invoice-pdf-reconciliation-dry-run");
  if (limitCheck.limited) {
    return NextResponse.json({ error: limitCheck.message }, { status: 429 });
  }

  const summary = await reconcileInvoicePdfArchiveObjectsDryRun({ now: new Date(), batchSize: BATCH_SIZE });
  return NextResponse.json(summary);
}
