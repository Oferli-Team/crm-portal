import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron/auth";
import { checkRateLimit, CRON_JOB_LIMIT } from "@/lib/rate-limit";
import { cleanupNotifications } from "@/lib/notifications/jobs/cleanup-notifications";

// Never statically cached/optimized — this must actually run, every time
// Vercel Cron (or a manual authorized call) hits it.
export const dynamic = "force-dynamic";

// A bounded batch per run, not a full-table delete — see
// docs/notifications-architecture.md's cron section: several daily runs
// gradually clear a large backlog instead of one long-running delete.
const BATCH_SIZE = 500;

/**
 * Vercel Cron sends a GET with `Authorization: Bearer <CRON_SECRET>` on
 * every scheduled invocation (see vercel.json). No session, Membership, or
 * portal cookie is ever read here — CRON_SECRET is the entire auth
 * boundary, checked once via the shared helper before anything else runs.
 */
export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  // Defense in depth only — CRON_SECRET is the real barrier. Bucketed by
  // this route's own fixed name, not by caller, so a legitimate scheduled
  // (or manually re-triggered) run is never the thing that trips it.
  const limitCheck = checkRateLimit(CRON_JOB_LIMIT, "notification-cleanup");
  if (limitCheck.limited) {
    return NextResponse.json({ error: limitCheck.message }, { status: 429 });
  }

  const summary = await cleanupNotifications({ now: new Date(), batchSize: BATCH_SIZE });
  return NextResponse.json(summary);
}
