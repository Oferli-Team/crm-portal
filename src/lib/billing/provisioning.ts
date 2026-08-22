import type { Prisma } from "@/generated/prisma/client";
import { DEFAULT_TRIAL_PLAN_KEY, TRIAL_DURATION_DAYS } from "./plans";

/**
 * Billing & Subscriptions Stage 2 (docs/billing-architecture.md §9,
 * refined by this stage's own explicit "automatic trial provisioning"
 * requirement — Stage 1 originally proposed an *implicit* trial with no
 * row at all; this stage instead creates a real TRIALING Subscription row
 * for every brand-new Organization, atomically).
 *
 * Must be called from inside the exact same `prisma.$transaction(...)`
 * that creates the Organization itself (see getOrCreateOrganizationId in
 * src/lib/current-user.ts) — either both rows exist or neither does, the
 * same all-or-nothing guarantee that transaction already gives the
 * Organization + OWNER Membership pair.
 *
 * Idempotent: `upsert` with an empty `update` means a retried/raced call
 * for an organizationId that already has a Subscription row is a silent
 * no-op, never a duplicate-row error and never an overwrite of real
 * subscription state — mirrors getOrCreateOrganizationId()'s own existing
 * P2002-tolerant idempotency for exactly the same class of concurrent-
 * first-login race (Next.js prefetching multiple sidebar links on a
 * user's very first request).
 *
 * Only ever called from this one real Organization-creation call site in
 * this stage — invited users joining an *existing* org
 * (acceptInvitationAction) never call this, and neither does a second
 * Membership in an org that already has one (both paths never create a
 * new Organization at all, so getOrCreateOrganizationId's own org-creation
 * branch — the only caller of this function — is never reached for them).
 */
export async function createTrialSubscription(
  tx: Prisma.TransactionClient,
  organizationId: string,
  now: Date,
): Promise<void> {
  const trialEndsAt = new Date(now.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);

  await tx.subscription.upsert({
    where: { organizationId },
    update: {},
    create: {
      organizationId,
      planKey: DEFAULT_TRIAL_PLAN_KEY,
      status: "TRIALING",
      trialStartedAt: now,
      trialEndsAt,
    },
  });
}
