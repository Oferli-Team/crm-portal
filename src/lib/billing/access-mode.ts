import type { SubscriptionStatus } from "@/generated/prisma/enums";

/**
 * Billing & Subscriptions Stage 2 (docs/billing-architecture.md §9/§13).
 * Pure, DB/IO-free — takes already-resolved subscription fields and the
 * caller's own `now`, returns a derived AccessMode. Never calls
 * `new Date()` internally (the caller always supplies `now`), the same
 * "caller supplies now" discipline this codebase already uses wherever a
 * pure function needs the current time (e.g. cleanupNotifications({ now })
 * in src/lib/notifications/jobs/cleanup-notifications.ts) — this is what
 * keeps every boundary-timestamp case in this module exactly reproducible
 * in tests.
 */

export type AccessMode = "FULL_ACCESS" | "LIMITED_WRITES" | "READ_ONLY";

export type SubscriptionStateInput = {
  status: SubscriptionStatus;
  trialEndsAt: Date;
  currentPeriodEnd: Date | null;
  gracePeriodEndsAt: Date | null;
};

/**
 * No Subscription row at all — an Organization that predates this stage
 * and has never been backfilled (see prisma/backfill-subscriptions.ts).
 * Always full access: merging this stage must never degrade an existing
 * production organization's access (docs/billing-architecture.md §9's own
 * "LEGACY/full access" requirement).
 */
export const LEGACY_ACCESS_MODE: AccessMode = "FULL_ACCESS";

/**
 * Stage 2 enforcement (src/lib/billing/enforcement.ts) only ever needs the
 * FULL_ACCESS vs. not-FULL_ACCESS distinction — new-resource creation is
 * blocked identically whether this returns LIMITED_WRITES or READ_ONLY
 * (see docs/billing-architecture.md §7's explicit rule: v1 only ever
 * blocks *new creation*, never makes existing data read-only, so there is
 * no enforcement point in this stage that would behave differently for
 * the two). The two values are still kept distinct here, not collapsed
 * into one boolean, because a later UI stage (docs/billing-architecture.md
 * §14) genuinely wants different messaging/urgency for "still has a
 * chance to recover" (LIMITED_WRITES — e.g. INCOMPLETE, mid-grace-period
 * would-be states) vs. "subscription has definitively ended" (READ_ONLY) —
 * computing the correct distinction now means no state-machine logic needs
 * to change once that UI exists.
 *
 * Every branch is grounded directly in docs/billing-architecture.md §13's
 * table; boundary timestamps are treated inclusively (`now` exactly equal
 * to a deadline still counts as "not yet expired") — see the state-machine
 * unit tests for the exact boundary cases this decision covers.
 */
export function computeAccessMode(input: SubscriptionStateInput, now: Date): AccessMode {
  const { status, trialEndsAt, currentPeriodEnd, gracePeriodEndsAt } = input;

  switch (status) {
    case "TRIALING":
      // Trial expired, never converted — docs/billing-architecture.md §9:
      // "read access continues, new-resource creation is blocked," the
      // same outcome CANCELED-after-period-end and UNPAID already produce.
      return now.getTime() <= trialEndsAt.getTime() ? "FULL_ACCESS" : "READ_ONLY";

    case "ACTIVE":
      return "FULL_ACCESS";

    case "PAST_DUE":
      // docs/billing-architecture.md §3/§13: full access continues,
      // unchanged, for the entire grace window — a single failed payment
      // attempt never degrades access immediately. No gracePeriodEndsAt
      // set at all (shouldn't happen once a real webhook handler exists,
      // Stage 4+) is treated as "grace already over," the conservative
      // (non-punitive-by-omission but also non-indefinite) default.
      if (gracePeriodEndsAt && now.getTime() <= gracePeriodEndsAt.getTime()) {
        return "FULL_ACCESS";
      }
      return "READ_ONLY";

    case "CANCELED":
      // cancelAtPeriodEnd semantics: a canceled subscription still grants
      // full access through whatever period was already paid for.
      if (currentPeriodEnd && now.getTime() <= currentPeriodEnd.getTime()) {
        return "FULL_ACCESS";
      }
      return "READ_ONLY";

    case "UNPAID":
      // The grace period (PAST_DUE) has already lapsed by the time a
      // subscription reaches UNPAID — no further grace to check here.
      return "READ_ONLY";

    case "INCOMPLETE":
      // No real checkout exists in this stage (no provider is connected),
      // so nothing in Stage 2 ever actually produces this status — kept
      // only so this switch stays exhaustive against the full
      // SubscriptionStatus enum. "Payment not yet confirmed" is not a
      // failure, so this resolves to the less punitive of the two options
      // docs/billing-architecture.md §9 offers, matching the design doc's
      // overall non-punitive default.
      return "LIMITED_WRITES";

    default: {
      const exhaustive: never = status;
      throw new Error(`Unhandled SubscriptionStatus: ${String(exhaustive)}`);
    }
  }
}
