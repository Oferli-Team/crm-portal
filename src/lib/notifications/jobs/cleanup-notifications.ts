import { prisma } from "@/lib/prisma";
import { emptyJobSummary, type JobSummary } from "./types";

/** 90 days from readAt — see docs/notifications-architecture.md's Retention section. Unread rows are never touched by age alone. */
export const NOTIFICATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type CleanupCandidate = { readAt: Date | null };

/**
 * The retention policy's spec, as a pure function — mirrors the Prisma
 * WHERE clause below exactly, so the rule (unread is never eligible; read
 * is eligible only once older than the retention window) is directly
 * unit-testable without a database.
 */
export function isEligibleForCleanup(notification: CleanupCandidate, now: Date): boolean {
  if (!notification.readAt) return false;
  const retentionThreshold = new Date(now.getTime() - NOTIFICATION_RETENTION_MS);
  return notification.readAt.getTime() < retentionThreshold.getTime();
}

/**
 * Deletes read Notification rows older than the retention window — see
 * docs/notifications-architecture.md's Retention section, which this
 * follows exactly (already-decided policy, not a new decision made here).
 *
 * Never touches: unread rows (readAt IS NULL, regardless of age — an
 * unread notification is something the recipient hasn't acknowledged yet,
 * never silently removed), Activity (this table has no relation Activity
 * points at — deleting a Notification can't affect it), or
 * NotificationPreference (a completely separate, per-user settings table).
 * NotificationDelivery cascades automatically via its own FK.
 *
 * Batched and idempotent: a fixed-size, ordered (createdAt, id) page per
 * call — never an unbounded DELETE — so a large backlog clears gradually
 * across several cron runs rather than one long-running table scan/lock,
 * and calling this repeatedly with no eligible rows left is a clean no-op
 * (an empty summary), not an error.
 *
 * `now` is caller-supplied for determinism/testability — no session,
 * Membership, or cookie dependency of any kind.
 */
export async function cleanupNotifications(params: { now: Date; batchSize: number }): Promise<JobSummary> {
  const { now, batchSize } = params;
  const summary = emptyJobSummary();

  const retentionThreshold = new Date(now.getTime() - NOTIFICATION_RETENTION_MS);

  const candidates = await prisma.notification.findMany({
    where: { readAt: { not: null, lt: retentionThreshold } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: batchSize,
    select: { id: true },
  });
  summary.scanned = candidates.length;

  if (candidates.length === 0) {
    return summary;
  }

  const result = await prisma.notification.deleteMany({
    where: { id: { in: candidates.map((c) => c.id) } },
  });
  summary.deleted = result.count;

  return summary;
}
