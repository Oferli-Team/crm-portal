import { prisma } from "@/lib/prisma";
import type { NotificationType, NotificationDeliveryStatus } from "@/generated/prisma/enums";
import { sendEmailViaResend, type SendEmailFn, type SendEmailResult } from "@/lib/email/resend-client";
import { resolveNotificationLinkPath } from "@/lib/notifications/format-notification";
import { shouldDeliverEmail, type NotificationPreferenceValue } from "@/lib/notifications/preferences";
import { formatNotificationEmail } from "./format-notification-email";

// MVP allowlist — evaluated per type, not per Activity, since one Activity
// can already fan out to several Notification rows of the same type (see
// INVOICE_STATUS_CHANGED's one-to-many rule) and every one of them makes
// its own independent email decision.
//
//   ROLE_CHANGED                 yes — directly affects what the recipient can do
//   OWNERSHIP_TRANSFERRED        yes — high-stakes, rare, worth an email
//   MEMBER_REMOVED               yes — the recipient may no longer be checking the app at all
//   INVITATION_ACCEPTED          NO  — the inviter is already active in the app; an
//                                      in-app badge is enough, an email is low value
//   PORTAL_INVITATION_ACCEPTED   yes — useful for the staff inviter, same reasoning as above
//   INVOICE_STATUS_CHANGED       yes, but noted — recipients are every OWNER/ADMIN in the
//                                      org (§4.2's one one-to-many fan-out rule); this can
//                                      mean an email to several people per status change.
//                                      Deliberately follows the existing Notification rows
//                                      rather than inventing a narrower email-only rule — a
//                                      digest or opt-out is a real follow-up, not MVP.
//   MENTIONED                    yes — a direct, personal "you specifically are wanted"
//                                      signal, the same reasoning as ROLE_CHANGED/
//                                      OWNERSHIP_TRANSFERRED (docs/comments-architecture.md
//                                      §5). A bare comment with no @mention never reaches
//                                      this allowlist at all — it never produces a
//                                      Notification in the first place.
//   SUBSCRIPTION_ACTIVATED       yes — docs/billing-architecture.md §17's own table:
//   PAYMENT_FAILED                     every billing event notifies the OWNER by both
//   SUBSCRIPTION_CANCELED              channels — these are consequential, low-volume,
//   PLAN_CHANGED                       OWNER-only events an email is clearly worth for.
const EMAIL_ALLOWLIST: ReadonlySet<NotificationType> = new Set([
  "ROLE_CHANGED",
  "OWNERSHIP_TRANSFERRED",
  "MEMBER_REMOVED",
  "PORTAL_INVITATION_ACCEPTED",
  "INVOICE_STATUS_CHANGED",
  "MENTIONED",
  "SUBSCRIPTION_ACTIVATED",
  "PAYMENT_FAILED",
  "SUBSCRIPTION_CANCELED",
  "PLAN_CHANGED",
]);

/**
 * Total attempts ever made, across both the request-bound first attempt
 * (deliverNotificationEmails, below) and the background retry job
 * (src/lib/notifications/jobs/retry-notification-deliveries.ts) — shared
 * so both agree on the same ceiling. Raised from Stage 6's MVP value of 1
 * to a real 3-attempt policy now that Stage 8 adds a job capable of
 * actually retrying later; the request-bound path itself still only ever
 * makes one attempt per call.
 */
export const MAX_ATTEMPTS = 3;

/**
 * Backoff, keyed by the attemptCount a FAILED row now has (i.e. the
 * attempt that just failed) — attempt 1 (the request-bound first try)
 * fails immediately with no wait; the job's first retry (attemptCount 1 ->
 * 2) waits at least 15 minutes from that failure; its second and final
 * retry (2 -> 3) waits at least 1 hour. No entry for attemptCount 3: that
 * attempt reaching MAX_ATTEMPTS is terminal, computeNextAttemptAt returns
 * null and the row stays FAILED with no further retry.
 */
const RETRY_BACKOFF_MS: Record<number, number> = {
  1: 15 * 60 * 1000,
  2: 60 * 60 * 1000,
};

/**
 * `newAttemptCount` is the attemptCount value a FAILED row now has, right
 * after recording this failure. Returns null when there's no scheduled
 * retry (either the ceiling was just reached, or — defensively — an
 * attemptCount this table shouldn't produce).
 */
export function computeNextAttemptAt(now: Date, newAttemptCount: number): Date | null {
  if (newAttemptCount >= MAX_ATTEMPTS) return null;
  const backoffMs = RETRY_BACKOFF_MS[newAttemptCount];
  if (backoffMs === undefined) return null;
  return new Date(now.getTime() + backoffMs);
}

export type ShouldDeliverResult =
  | { deliver: true }
  | {
      deliver: false;
      reason:
        | "disabled_by_preference"
        | "not_allowlisted"
        | "no_recipient_email"
        | "not_configured"
        | "already_resolved"
        | "retry_limit_reached";
    };

/**
 * The one place every "should we email this?" decision is made — a pure
 * function, no I/O, so every branch (user preference, allowlist, missing
 * recipient email, unconfigured provider, an already-SENT/SKIPPED row, a
 * FAILED row past its retry ceiling) is unit-testable without a database.
 * deliverNotificationEmails below is a thin orchestrator around this:
 * fetch data, call this, act on the result.
 *
 * Preference is checked before the allowlist, per Stage 7's design: a
 * user's own toggle can only narrow what would otherwise be sent, never
 * widen it past the allowlist (enabling email for a type this app never
 * emails at all still sends nothing) — the allowlist is a system-level
 * ceiling, the preference is a user-level floor beneath it.
 */
export function shouldDeliverNotificationEmail(params: {
  notification: { type: NotificationType };
  recipient: { email: string | null | undefined };
  providerConfigured: boolean;
  preference?: NotificationPreferenceValue | null;
  existingDelivery?: { status: NotificationDeliveryStatus; attemptCount: number } | null;
}): ShouldDeliverResult {
  if (params.existingDelivery) {
    const { status, attemptCount } = params.existingDelivery;
    if (status === "SENT" || status === "SKIPPED") {
      return { deliver: false, reason: "already_resolved" };
    }
    if (status === "FAILED" && attemptCount >= MAX_ATTEMPTS) {
      return { deliver: false, reason: "retry_limit_reached" };
    }
  }

  if (!shouldDeliverEmail(params.preference)) {
    return { deliver: false, reason: "disabled_by_preference" };
  }
  if (!EMAIL_ALLOWLIST.has(params.notification.type)) {
    return { deliver: false, reason: "not_allowlisted" };
  }
  if (!params.recipient.email || params.recipient.email.trim().length === 0) {
    return { deliver: false, reason: "no_recipient_email" };
  }
  if (!params.providerConfigured) {
    return { deliver: false, reason: "not_configured" };
  }

  return { deliver: true };
}

/** Same reasoning as src/lib/email/invitations.ts's own copy — never derived from a request header. */
function getAppBaseUrl(): string {
  const explicit = process.env.APP_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`.replace(/\/+$/, "");

  return "http://localhost:3000";
}

export type DeliverySummary = {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
};

/**
 * Exported so the retry job (src/lib/notifications/jobs/retry-
 * notification-deliveries.ts) records SKIPPED/FAILED/SENT outcomes
 * through this exact same write path, rather than a second copy of it —
 * one place decides what a delivery row looks like after any given
 * outcome, regardless of which caller produced it.
 */
export async function upsertSkipped(notificationId: string, failureCode: string): Promise<void> {
  await prisma.notificationDelivery.upsert({
    where: { notificationId_channel: { notificationId, channel: "EMAIL" } },
    create: { notificationId, channel: "EMAIL", status: "SKIPPED", failureCode, attemptCount: 0 },
    update: {
      status: "SKIPPED",
      failureCode,
      attemptedAt: null,
      deliveredAt: null,
      nextAttemptAt: null,
      lockedAt: null,
    },
  });
}

/**
 * `currentAttemptCount` is the row's attemptCount *before* this attempt —
 * the caller always already knows it (either 0, for a brand new row, or
 * whatever it just read/claimed) — so nextAttemptAt can be computed from
 * a known resulting count rather than relying on the database to report
 * back the result of an `increment`.
 */
export async function upsertAttempt(
  notificationId: string,
  currentAttemptCount: number,
  result: { status: "SENT" | "FAILED"; failureCode: string | null },
  now: Date = new Date(),
): Promise<void> {
  const newAttemptCount = currentAttemptCount + 1;
  const deliveredAt = result.status === "SENT" ? now : null;
  const nextAttemptAt = result.status === "FAILED" ? computeNextAttemptAt(now, newAttemptCount) : null;

  await prisma.notificationDelivery.upsert({
    where: { notificationId_channel: { notificationId, channel: "EMAIL" } },
    create: {
      notificationId,
      channel: "EMAIL",
      status: result.status,
      attemptedAt: now,
      deliveredAt,
      failureCode: result.failureCode,
      attemptCount: newAttemptCount,
      nextAttemptAt,
    },
    update: {
      status: result.status,
      attemptedAt: now,
      deliveredAt,
      failureCode: result.failureCode,
      attemptCount: newAttemptCount,
      nextAttemptAt,
      lockedAt: null,
    },
  });
}

/**
 * Best-effort, request-bound, post-commit email delivery for Notification
 * rows that already exist and are already committed. Never call this from
 * inside the prisma.$transaction() that created them (see createActivity) —
 * an email provider outage must never roll back a business mutation, and
 * this function's own failures never propagate as a throw for exactly that
 * reason: every outcome (ineligible, unconfigured, provider failure,
 * success) resolves to a NotificationDelivery row instead of an exception.
 *
 * `@@unique([notificationId, channel])` is what makes a duplicate call for
 * the same notificationIds safe — shouldDeliverNotificationEmail's
 * "already_resolved"/"retry_limit_reached" branches turn a repeat call into
 * a pure no-op instead of a second email or a constraint error.
 *
 * `deps.sendEmail` is the sole seam for tests — inject a fake to assert on
 * what was built (recipient/subject/HTML) or to simulate provider success/
 * failure, without a real Resend call. Never logs the recipient email,
 * subject, rendered body, or a raw provider error — only the coarse,
 * non-identifying `failureCode` already returned by sendEmailViaResend
 * ever reaches the database.
 */
export async function deliverNotificationEmails(
  notificationIds: string[],
  deps: { sendEmail?: SendEmailFn } = {},
): Promise<DeliverySummary> {
  const summary: DeliverySummary = { attempted: 0, sent: 0, failed: 0, skipped: 0 };
  if (notificationIds.length === 0) return summary;

  const sendEmail = deps.sendEmail ?? sendEmailViaResend;
  const fromEmail = process.env.INVITATION_FROM_EMAIL;
  const providerConfigured = Boolean(fromEmail);

  // notificationPreferences is the recipient's *entire* preference set
  // (at most 6 rows, one per NotificationType) — one join-like fetch here,
  // not a per-notification query, then matched to each row's own type
  // in-memory below.
  const notifications = await prisma.notification.findMany({
    where: { id: { in: notificationIds } },
    include: {
      recipient: { select: { email: true, notificationPreferences: true } },
      organization: { select: { name: true } },
      deliveries: { where: { channel: "EMAIL" } },
    },
  });

  for (const notification of notifications) {
    const existing = notification.deliveries[0] ?? null;
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
      existingDelivery: existing ? { status: existing.status, attemptCount: existing.attemptCount } : null,
    });

    if (!decision.deliver) {
      // Already resolved by an earlier call — a genuine no-op, not
      // re-counted or re-written.
      if (decision.reason === "already_resolved" || decision.reason === "retry_limit_reached") {
        continue;
      }
      summary.attempted += 1;
      await upsertSkipped(notification.id, decision.reason);
      summary.skipped += 1;
      continue;
    }

    summary.attempted += 1;

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
      // fromEmail/recipient.email are both guaranteed non-null here —
      // decision.deliver is only true when providerConfigured and
      // no_recipient_email were both already checked above.
      result = await sendEmail({
        to: notification.recipient.email as string,
        from: fromEmail as string,
        subject: content.subject,
        html: content.html,
        text: content.text,
      });
    } catch {
      // sendEmailViaResend is documented to never throw, but a DI'd
      // provider must never be trusted to uphold that — this helper stays
      // best-effort no matter what the injected function does.
      result = { ok: false, reason: "network_error" };
    }

    const currentAttemptCount = existing?.attemptCount ?? 0;
    if (result.ok) {
      await upsertAttempt(notification.id, currentAttemptCount, { status: "SENT", failureCode: null });
      summary.sent += 1;
    } else {
      await upsertAttempt(notification.id, currentAttemptCount, { status: "FAILED", failureCode: result.reason });
      summary.failed += 1;
    }
  }

  return summary;
}
