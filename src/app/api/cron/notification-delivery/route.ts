import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron/auth";
import { checkRateLimit, CRON_JOB_LIMIT } from "@/lib/rate-limit";
import { retryNotificationDeliveries } from "@/lib/notifications/jobs/retry-notification-deliveries";

// Never statically cached/optimized — this must actually run, every time
// Vercel Cron (or a manual authorized call) hits it.
export const dynamic = "force-dynamic";

// Bounded per run — see docs/notifications-architecture.md's cron section
// for why a fixed batch size (not "process everything") is what keeps this
// job's own run time predictable regardless of backlog size.
const BATCH_LIMIT = 200;

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
  const limitCheck = checkRateLimit(CRON_JOB_LIMIT, "notification-delivery");
  if (limitCheck.limited) {
    return NextResponse.json({ error: limitCheck.message }, { status: 429 });
  }

  const summary = await retryNotificationDeliveries({ now: new Date(), limit: BATCH_LIMIT });
  return NextResponse.json(summary);
}
