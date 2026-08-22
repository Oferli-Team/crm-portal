import { prisma } from "@/lib/prisma";
import type { NotificationDeliveryStatus } from "@/generated/prisma/enums";
import { sendEmailViaResend, type SendEmailFn, type SendEmailResult } from "@/lib/email/resend-client";
import { resolveNotificationLinkPath } from "@/lib/notifications/format-notification";
import { formatNotificationEmail } from "@/lib/notifications/email/format-notification-email";
import {
  shouldDeliverNotificationEmail,
  upsertSkipped,
  upsertAttempt,
  MAX_ATTEMPTS,
} from "@/lib/notifications/email/deliver-notification-email";
import { emptyJobSummary, type JobSummary } from "./types";

/** A PROCESSING row locked longer than this is presumed to belong to a worker that died mid-attempt — safe to reclaim. */
export const STALE_LOCK_MS = 10 * 60 * 1000;

export type DeliveryClaimCandidate = {
  status: NotificationDeliveryStatus;
  attemptCount: number;
  nextAttemptAt: Date | null;
  lockedAt: Date | null;
};

/**
 * The retry policy's spec, as a pure function — no I/O, so every branch is
 * unit-testable without a database. The job's own Prisma queries below
 * implement this exact same logic as SQL WHERE clauses (Prisma can't call
 * a JS predicate mid-query); this function is what those clauses are
 * verified against, both in unit tests (the logic) and integration tests
 * (that the SQL actually matches it).
 *
 * PENDING is always eligible (never actually persisted by the request-
 * bound path today, but the claim logic still honors it — see deliver-
 * notification-email.ts's own note on why the enum value exists anyway).
 * FAILED is eligible only under the attempt ceiling AND once nextAttemptAt
 * has passed (or was never set). PROCESSING is only eligible if its
 * lockedAt is older than staleLockMs — a fresh PROCESSING row belongs to
 * a run that's still (or was, moments ago) actively working it. SENT and
 * SKIPPED are never eligible — both are terminal.
 */
export function isEligibleForRetryClaim(
  row: DeliveryClaimCandidate,
  now: Date,
  staleLockMs: number = STALE_LOCK_MS,
): boolean {
  if (row.status === "PENDING") {
    return true;
  }
  if (row.status === "FAILED") {
    if (row.attemptCount >= MAX_ATTEMPTS) return false;
    if (row.nextAttemptAt && row.nextAttemptAt.getTime() > now.getTime()) return false;
    return true;
  }
  if (row.status === "PROCESSING") {
    if (!row.lockedAt) return false;
    return now.getTime() - row.lockedAt.getTime() > staleLockMs;
  }
  return false;
}

/** Same reasoning as deliver-notification-email.ts's own copy — never derived from a request header, kept as its own copy per this app's established convention (see src/lib/email/invitations.ts vs client-portal-invitations.ts). */
function getAppBaseUrl(): string {
  const explicit = process.env.APP_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`.replace(/\/+$/, "");

  return "http://localhost:3000";
}

/**
 * Background retry for notification email delivery — the counterpart to
 * deliverNotificationEmails' request-bound first attempt (src/lib/
 * notifications/email/deliver-notification-email.ts). Meant to be called
 * from a cron-triggered Route Handler, never from user request handling:
 * `now`/`limit` are caller-supplied so every run (and every test) is
 * deterministic, and there is no session/Membership/cookie dependency of
 * any kind — this only ever reads/writes NotificationDelivery + the
 * Notification/User/NotificationPreference rows it points at.
 *
 * Scope, deliberately: this only retries deliveries that *already have* a
 * NotificationDelivery row (PENDING or FAILED-under-ceiling), plus stale
 * PROCESSING rows left behind by a crashed previous run. It does not scan
 * for Notification rows with no delivery row at all — every notification-
 * producing call site already calls deliverNotificationEmails synchronously
 * post-commit (Stage 6/7), so a missing row would mean that call never
 * even started (the request died before reaching it), which is a
 * different, rarer failure mode than "the attempt was made and failed."
 * Backfilling those is intentionally out of scope for this stage.
 *
 * Concurrency: claiming is a conditional updateMany (`WHERE status =
 * 'FAILED'/'PENDING'` or `WHERE status = 'PROCESSING' AND lockedAt < stale
 * threshold`) — Postgres evaluates each row's WHERE clause at the moment
 * that row's UPDATE actually executes, so if two job runs race for the
 * same row, only the one whose UPDATE commits first still sees the
 * expected starting status; the loser's WHERE no longer matches and its
 * update simply skips that row. The immediate re-query (`status =
 * 'PROCESSING' AND lockedAt = now`) is how each run learns exactly which
 * rows *it* just claimed, since `now` is unique per invocation.
 */
export async function retryNotificationDeliveries(params: {
  now: Date;
  limit: number;
  sendEmail?: SendEmailFn;
}): Promise<JobSummary> {
  const { now, limit } = params;
  const sendEmail = params.sendEmail ?? sendEmailViaResend;
  const summary = emptyJobSummary();

  const staleThreshold = new Date(now.getTime() - STALE_LOCK_MS);

  // 1. Reclaim stale PROCESSING rows first — a worker that claimed these
  // and never finished (crashed, timed out) left them stranded.
  const staleCandidates = await prisma.notificationDelivery.findMany({
    where: { channel: "EMAIL", status: "PROCESSING", lockedAt: { lt: staleThreshold } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true },
  });
  if (staleCandidates.length > 0) {
    await prisma.notificationDelivery.updateMany({
      where: {
        id: { in: staleCandidates.map((c) => c.id) },
        status: "PROCESSING",
        lockedAt: { lt: staleThreshold },
      },
      data: { lockedAt: now },
    });
  }

  // 2. Claim fresh PENDING/FAILED rows due for retry, filling out the rest
  // of this run's batch limit.
  const remainingLimit = Math.max(limit - staleCandidates.length, 0);
  const freshCandidates =
    remainingLimit > 0
      ? await prisma.notificationDelivery.findMany({
          where: {
            channel: "EMAIL",
            OR: [
              { status: "PENDING" },
              {
                status: "FAILED",
                attemptCount: { lt: MAX_ATTEMPTS },
                OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
              },
            ],
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: remainingLimit,
          select: { id: true },
        })
      : [];
  if (freshCandidates.length > 0) {
    await prisma.notificationDelivery.updateMany({
      where: { id: { in: freshCandidates.map((c) => c.id) }, status: { in: ["PENDING", "FAILED"] } },
      data: { status: "PROCESSING", lockedAt: now },
    });
  }

  summary.scanned = staleCandidates.length + freshCandidates.length;

  const allCandidateIds = [...staleCandidates, ...freshCandidates].map((c) => c.id);
  if (allCandidateIds.length === 0) {
    return summary;
  }

  // The definitive "what did THIS run actually claim" read — see the
  // function-level comment on why lockedAt = now (an exact match, not a
  // range) is what makes this race-safe.
  const claimed = await prisma.notificationDelivery.findMany({
    where: { id: { in: allCandidateIds }, status: "PROCESSING", lockedAt: now },
    include: {
      notification: {
        include: {
          recipient: { select: { email: true, notificationPreferences: true } },
          organization: { select: { name: true } },
        },
      },
    },
  });
  summary.claimed = claimed.length;

  const fromEmail = process.env.INVITATION_FROM_EMAIL;
  const providerConfigured = Boolean(fromEmail);

  for (const delivery of claimed) {
    try {
      const notification = delivery.notification;
      // A concurrent deletion (e.g. the recipient's own account removed,
      // cascading the Notification and this Delivery row with it) between
      // our claim and here — nothing left to do, not an error.
      if (!notification) continue;

      const preferenceRow = notification.recipient.notificationPreferences.find(
        (p) => p.type === notification.type,
      );

      const decision = shouldDeliverNotificationEmail({
        notification: { type: notification.type },
        recipient: { email: notification.recipient.email },
        providerConfigured,
        preference: preferenceRow
          ? { inAppEnabled: preferenceRow.inAppEnabled, emailEnabled: preferenceRow.emailEnabled }
          : null,
        // No existingDelivery here on purpose — this row is PROCESSING
        // (our own claim) right now, not SENT/SKIPPED/FAILED; there is
        // nothing left for that branch to compare against. Everything
        // from here on is a fresh preference/allowlist/recipient/provider
        // re-check against the current, possibly-changed state.
      });

      if (!decision.deliver) {
        await upsertSkipped(notification.id, decision.reason);
        summary.skipped += 1;
        continue;
      }

      const linkPath = resolveNotificationLinkPath(notification.type, notification.entityId, notification.metadata);
      const ctaUrl = `${getAppBaseUrl()}${linkPath ?? "/notifications"}`;
      const content = formatNotificationEmail({
        type: notification.type,
        metadata: notification.metadata,
        entityId: notification.entityId,
        organizationName: notification.organization.name,
        ctaUrl,
      });

      let result: SendEmailResult;
      try {
        result = await sendEmail({
          to: notification.recipient.email as string,
          from: fromEmail as string,
          subject: content.subject,
          html: content.html,
          text: content.text,
        });
      } catch {
        result = { ok: false, reason: "network_error" };
      }

      if (result.ok) {
        await upsertAttempt(notification.id, delivery.attemptCount, { status: "SENT", failureCode: null }, now);
        summary.sent += 1;
      } else {
        await upsertAttempt(
          notification.id,
          delivery.attemptCount,
          { status: "FAILED", failureCode: result.reason },
          now,
        );
        summary.failed += 1;
      }
    } catch {
      // One claimed row's own processing failed unexpectedly (a DB
      // hiccup, not a provider error — those are already caught above) —
      // it stays PROCESSING and gets reclaimed as stale on a later run,
      // but every other claimed row in this batch still gets processed.
      continue;
    }
  }

  return summary;
}
