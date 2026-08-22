import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { getBillingProviderAdapter } from "@/lib/billing/provider/provider";
import { applyBillingEventToSubscription, type SubscriptionRowForMapping } from "@/lib/billing/event-mapper";
import { createBillingNotification, type BillingNotificationType } from "@/lib/billing/notify";
import { deliverNotificationEmails } from "@/lib/notifications/email/deliver-notification-email";
import { getPlan, isPlanKey } from "@/lib/billing/plans";
import { checkRateLimit, BILLING_WEBHOOK_LIMIT } from "@/lib/rate-limit";

/**
 * Billing & Subscriptions Stage 4 (this stage's own §7). Provider-neutral
 * webhook endpoint — no user session/cookie is ever read here (a webhook
 * request has no browser session at all); the adapter's own signature
 * verification is the entire trust boundary.
 *
 * Never statically cached/optimized — this must actually run on every
 * delivery, the same reasoning every other Route Handler with real
 * side effects in this app already documents (see the cron routes).
 */
export const dynamic = "force-dynamic";

type WebhookFailureCode =
  | "missing_organization"
  | "unknown_organization"
  | "provider_id_conflict"
  | "malformed_event";

function planDisplayNameFor(planKey: string): string {
  return isPlanKey(planKey) ? getPlan(planKey).displayName : planKey;
}

function toSubscriptionRowForMapping(row: {
  planKey: string;
  status: SubscriptionRowForMapping["status"];
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  gracePeriodEndsAt: Date | null;
  providerUpdatedAt: Date | null;
}): SubscriptionRowForMapping {
  return {
    planKey: row.planKey,
    status: row.status,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    canceledAt: row.canceledAt,
    gracePeriodEndsAt: row.gracePeriodEndsAt,
    providerUpdatedAt: row.providerUpdatedAt,
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  // Read exactly once — every downstream check (signature verification,
  // parsing) works off this same string, never a second request.text()/
  // request.json() call.
  const rawBody = await request.text();

  const adapter = getBillingProviderAdapter();
  if (adapter.kind === "unconfigured") {
    // Fail closed: no signature could ever verify against an unconfigured
    // provider, and there is nothing to process — generic response, no DB
    // write, no distinguishing detail returned to the caller.
    return NextResponse.json({ error: "Not configured" }, { status: 400 });
  }

  const verification = adapter.verifyWebhook({ rawBody, headers: request.headers });
  if (!verification.verified) {
    // Never echoes `verification.reason` back to the caller or logs the
    // raw body/headers — a failed signature check reveals nothing beyond
    // "rejected."
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Defense in depth only, same reasoning as CRON_JOB_LIMIT — signature
  // verification (just above) is the real barrier.
  const limitCheck = checkRateLimit(BILLING_WEBHOOK_LIMIT, "billing-webhook");
  if (limitCheck.limited) {
    return NextResponse.json({ error: limitCheck.message }, { status: 429 });
  }

  const event = adapter.parseWebhookEvent(rawBody);
  if (!event) {
    // No providerEventId is even recoverable here — nothing to record.
    return NextResponse.json({ error: "Malformed payload" }, { status: 400 });
  }

  // Resolve + validate the claimed organization before ever inserting a
  // WebhookEvent row, so the row's own organizationId is only ever set to
  // a real, existing Organization — never a value that would violate the
  // column's own foreign key.
  let resolvedOrganizationId: string | null = null;
  let failureCode: WebhookFailureCode | null = null;

  if (!event.organizationId) {
    failureCode = "missing_organization";
  } else {
    const org = await prisma.organization.findUnique({ where: { id: event.organizationId }, select: { id: true } });
    if (!org) {
      failureCode = "unknown_organization";
    } else {
      resolvedOrganizationId = org.id;

      // Cross-org reassignment guard (this stage's own §9): a provider
      // customer/subscription id already bound to a *different* org's
      // Subscription row is never allowed to silently reassign it.
      const idFilters = [
        event.providerCustomerId ? { providerCustomerId: event.providerCustomerId } : null,
        event.providerSubscriptionId ? { providerSubscriptionId: event.providerSubscriptionId } : null,
      ].filter((f): f is { providerCustomerId: string } | { providerSubscriptionId: string } => f !== null);

      if (idFilters.length > 0) {
        const conflict = await prisma.subscription.findFirst({
          where: { organizationId: { not: resolvedOrganizationId }, OR: idFilters },
          select: { id: true },
        });
        if (conflict) {
          failureCode = "provider_id_conflict";
        }
      }
    }
  }

  // Idempotency: the database's own unique constraint on providerEventId
  // is the authoritative dedup mechanism (a check-then-insert would race
  // under concurrent redelivery) — a P2002 here means this exact event was
  // already received, and is a safe no-op, never reprocessed.
  let webhookEventId: string;
  try {
    const created = await prisma.webhookEvent.create({
      data: {
        provider: adapter.name,
        providerEventId: event.providerEventId,
        eventType: event.type,
        eventCreatedAt: event.providerCreatedAt,
        organizationId: resolvedOrganizationId,
        processingStatus: "PENDING",
        attempts: 1,
      },
      select: { id: true },
    });
    webhookEventId = created.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    throw err;
  }

  const now = new Date();

  if (failureCode) {
    await prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: { processingStatus: "FAILED", failureCode, processedAt: now },
    });
    // 200: a permanent, deterministic failure (unknown org, id conflict,
    // no org claim at all) — retrying the identical payload would fail
    // the exact same way, so there is nothing a retry could fix.
    return NextResponse.json({ received: true });
  }

  const existingSubscription = await prisma.subscription.findUnique({ where: { organizationId: resolvedOrganizationId! } });

  const outcome = applyBillingEventToSubscription({
    event,
    existingSubscription: existingSubscription ? toSubscriptionRowForMapping(existingSubscription) : null,
    now,
  });

  if (outcome.outcome === "IGNORE_EVENT_TYPE" || outcome.outcome === "IGNORE_OLDER_EVENT") {
    await prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: { processingStatus: "IGNORED", processedAt: now },
    });
    return NextResponse.json({ received: true });
  }

  if (outcome.outcome === "REJECT_MISSING_ORGANIZATION" || outcome.outcome === "REJECT_MALFORMED") {
    // Defensive only — the checks above already guarantee a resolved
    // organizationId and a well-formed event by this point; the mapper is
    // still the final authority and this path must never crash if it
    // somehow disagrees.
    await prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: { processingStatus: "FAILED", failureCode: "malformed_event", processedAt: now },
    });
    return NextResponse.json({ received: true });
  }

  // outcome.outcome === "APPLY" — one atomic unit: the Subscription write,
  // the WebhookEvent's own terminal status, and any Notification rows all
  // succeed or all roll back together. A single event's failure here can
  // never leave the Subscription row half-updated or the WebhookEvent
  // stuck in a non-terminal state.
  const notificationIds = await prisma.$transaction(async (tx) => {
    await tx.subscription.upsert({
      where: { organizationId: resolvedOrganizationId! },
      create: {
        organizationId: resolvedOrganizationId!,
        // A webhook-driven org should already have a Subscription row
        // from signup provisioning (src/lib/billing/provisioning.ts) —
        // this create branch only matters for the unusual case of a
        // LEGACY-backfilled org completing its very first real checkout
        // with no prior row at all. trialStartedAt/trialEndsAt backdated
        // to now, the same "irrelevant once a real status is set"
        // reasoning prisma/backfill-subscriptions.ts already documents.
        trialStartedAt: now,
        trialEndsAt: now,
        ...outcome.data,
      },
      update: { ...outcome.data },
    });

    await tx.webhookEvent.update({
      where: { id: webhookEventId },
      data: { processingStatus: "PROCESSED", processedAt: now },
    });

    const becameActive = outcome.data.status === "ACTIVE" && existingSubscription?.status !== "ACTIVE";
    const becamePastDue = outcome.data.status === "PAST_DUE" && existingSubscription?.status !== "PAST_DUE";
    const becameCanceled = outcome.data.status === "CANCELED" && existingSubscription?.status !== "CANCELED";
    // A genuine mid-subscription plan change — was already active, still
    // is, just on a different plan. A first-time checkout also technically
    // changes planKey (TRIAL -> STARTER/PRO) but that's SUBSCRIPTION_ACTIVATED's
    // story to tell, not a second, redundant PLAN_CHANGED notification.
    const planChangedWhileActive =
      outcome.planChanged && existingSubscription?.status === "ACTIVE" && outcome.data.status === "ACTIVE";

    const ids: string[] = [];
    const planName = planDisplayNameFor(outcome.data.planKey);

    const notify = async (type: BillingNotificationType, metadata: { planName: string; previousPlanName?: string }) => {
      const id = await createBillingNotification(tx, { organizationId: resolvedOrganizationId!, type, metadata });
      if (id) ids.push(id);
    };

    if (becameActive) {
      await notify("SUBSCRIPTION_ACTIVATED", { planName });
    } else if (planChangedWhileActive) {
      await notify("PLAN_CHANGED", {
        planName,
        previousPlanName: existingSubscription ? planDisplayNameFor(existingSubscription.planKey) : undefined,
      });
    }
    if (becamePastDue) {
      await notify("PAYMENT_FAILED", { planName });
    }
    if (becameCanceled) {
      await notify("SUBSCRIPTION_CANCELED", { planName });
    }

    return ids;
  });

  // Post-commit, best-effort — see deliverNotificationEmails's own header.
  await deliverNotificationEmails(notificationIds);

  return NextResponse.json({ received: true });
}
