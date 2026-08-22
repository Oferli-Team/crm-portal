import type { SubscriptionStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { computeAccessMode, LEGACY_ACCESS_MODE, type AccessMode } from "./access-mode";
import { getOrganizationUsage, type OrganizationUsage, type PrismaClientOrTx } from "./usage";
import { getPlan, isPlanKey, LEGACY_PLAN_KEY, type PlanKey } from "./plans";

/**
 * Billing & Subscriptions Stage 2 (docs/billing-architecture.md §7/§8/§13).
 * Every reason a create/invite/upload can be blocked — never a raw
 * provider status, never a database error, matching this stage's own
 * error-contract rule (docs/billing-architecture.md §15's "no client-
 * trusted plan" discipline extended to error surfaces: a user-facing
 * reason is always one of these five fixed codes, never anything provider-
 * or database-shaped).
 */
export type EntitlementReasonCode =
  | "MEMBER_LIMIT_REACHED"
  | "CLIENT_LIMIT_REACHED"
  | "PROJECT_LIMIT_REACHED"
  | "STORAGE_LIMIT_REACHED"
  | "READ_ONLY_ACCESS";

/**
 * The subset of a Subscription row buildOrganizationEntitlements actually
 * needs — deliberately not the full Prisma `Subscription` model, so this
 * pure function's own tests never need to construct an entire fake row
 * (id, provider, providerCustomerId, timestamps this function never
 * reads, etc.) just to exercise its logic.
 */
export type SubscriptionStateForEntitlements = {
  planKey: string;
  status: SubscriptionStatus;
  trialEndsAt: Date;
  currentPeriodEnd: Date | null;
  gracePeriodEndsAt: Date | null;
};

export type OrganizationEntitlements = {
  planKey: PlanKey;
  /**
   * Stage 5 audit fix: `"LEGACY"` whenever the resolved `planKey` above is
   * `LEGACY` — either because no Subscription row exists at all, or
   * because a real row's own `planKey` resolved to Legacy (an explicit
   * `LEGACY`-plan row from `prisma/backfill-subscriptions.ts`, or an
   * unrecognized value normalized by the fallback below). Previously this
   * only checked "no row exists," which meant a real row with an
   * unrecognized/explicitly-Legacy `planKey` but a real `status` (e.g. the
   * backfill script's own `status: "ACTIVE"`) rendered as plan "Legacy
   * (pre-billing)" next to a green "Active" status badge and "Your
   * subscription is active" message — internally contradictory for an
   * organization that has never had a real, paid subscription. Never a
   * real provider-reported status either way.
   */
  subscriptionStatus: SubscriptionStatus | "LEGACY";
  accessMode: AccessMode;

  maxMembers: number;
  maxClients: number | null;
  maxProjects: number | null;
  maxStorageBytes: number;

  currentMembers: number;
  currentClients: number;
  currentProjects: number;
  currentStorageBytes: number;

  canInviteMember: boolean;
  canCreateClient: boolean;
  canCreateProject: boolean;
  canUploadBytes: (size: number) => boolean;

  trialEndsAt: Date | null;
  gracePeriodEndsAt: Date | null;

  /** Every reason at least one `can*` boolean above is currently false — empty when nothing is blocked. Never includes a reason for a check that would pass. */
  blockedReasons: readonly EntitlementReasonCode[];
};

/**
 * Pure — no I/O, no Prisma import reachable from this function's own call
 * graph. Takes already-resolved subscription state (or `null`, meaning "no
 * Subscription row — legacy org") and already-computed usage, returns the
 * full entitlements contract. `usage.pendingInvitations` is folded into
 * the member-limit check (docs/billing-architecture.md §8: "inviting 5
 * people for a 5-seat plan should be blocked at the invite, not silently
 * allowed to over-accept later") but never affects `currentMembers`, which
 * always reports real, already-accepted Membership rows only.
 *
 * Never returns a provider id, a raw database error, or any field the
 * design doc's §5 "what this schema must never store"/§15 "no client-
 * trusted plan" rules would object to.
 */
export function buildOrganizationEntitlements({
  subscription,
  usage,
  now,
}: {
  subscription: SubscriptionStateForEntitlements | null;
  usage: OrganizationUsage & { pendingInvitations: number };
  now: Date;
}): OrganizationEntitlements {
  const planKey: PlanKey =
    subscription && isPlanKey(subscription.planKey) ? subscription.planKey : LEGACY_PLAN_KEY;
  const plan = getPlan(planKey);
  const isLegacyPlan = planKey === LEGACY_PLAN_KEY;

  const accessMode: AccessMode = subscription
    ? computeAccessMode(subscription, now)
    : LEGACY_ACCESS_MODE;

  const canCreateNewResources = accessMode === "FULL_ACCESS";

  const membersForLimitCheck = usage.members + usage.pendingInvitations;
  const underMemberLimit = membersForLimitCheck < plan.limits.maxMembers;
  const underClientLimit = plan.limits.maxClients === null || usage.clients < plan.limits.maxClients;
  const underProjectLimit = plan.limits.maxProjects === null || usage.projects < plan.limits.maxProjects;
  const underStorageLimit = usage.storageBytes < plan.limits.maxStorageBytes;

  const blockedReasons: EntitlementReasonCode[] = [];
  if (!canCreateNewResources) blockedReasons.push("READ_ONLY_ACCESS");
  if (!underMemberLimit) blockedReasons.push("MEMBER_LIMIT_REACHED");
  if (!underClientLimit) blockedReasons.push("CLIENT_LIMIT_REACHED");
  if (!underProjectLimit) blockedReasons.push("PROJECT_LIMIT_REACHED");
  if (!underStorageLimit) blockedReasons.push("STORAGE_LIMIT_REACHED");

  return {
    planKey,
    subscriptionStatus: subscription && !isLegacyPlan ? subscription.status : "LEGACY",
    accessMode,

    maxMembers: plan.limits.maxMembers,
    maxClients: plan.limits.maxClients,
    maxProjects: plan.limits.maxProjects,
    maxStorageBytes: plan.limits.maxStorageBytes,

    currentMembers: usage.members,
    currentClients: usage.clients,
    currentProjects: usage.projects,
    currentStorageBytes: usage.storageBytes,

    canInviteMember: canCreateNewResources && underMemberLimit,
    canCreateClient: canCreateNewResources && underClientLimit,
    canCreateProject: canCreateNewResources && underProjectLimit,
    canUploadBytes: (size: number) =>
      canCreateNewResources && usage.storageBytes + Math.max(size, 0) <= plan.limits.maxStorageBytes,

    trialEndsAt: subscription ? subscription.trialEndsAt : null,
    gracePeriodEndsAt: subscription?.gracePeriodEndsAt ?? null,

    blockedReasons,
  };
}

/**
 * The single DB-backed entry point every Server Action should call
 * (docs/billing-architecture.md §7's "one function, one call site pattern"
 * — mirrors how getCurrentUserOrganization() is already the one resolved-
 * context function every page/action in this app calls). Reads the local
 * Subscription row plus live usage counts, never calls a payment provider
 * (none is connected in this stage; §4's "never call the provider
 * synchronously on the request path" rule holds regardless).
 *
 * Accepts a Prisma client explicitly (default: the app singleton) so a
 * caller can pass its own transaction client for an atomic re-check
 * immediately before a write — see src/lib/billing/enforcement.ts.
 */
export async function getOrganizationEntitlements(
  organizationId: string,
  options?: { client?: PrismaClientOrTx; now?: Date },
): Promise<OrganizationEntitlements> {
  const client = options?.client ?? prisma;
  const now = options?.now ?? new Date();

  const [subscription, usage, pendingInvitations] = await Promise.all([
    client.subscription.findUnique({ where: { organizationId } }),
    getOrganizationUsage(client, organizationId),
    client.invitation.count({ where: { organizationId, status: "PENDING" } }),
  ]);

  return buildOrganizationEntitlements({
    subscription: subscription
      ? {
          planKey: subscription.planKey,
          status: subscription.status,
          trialEndsAt: subscription.trialEndsAt,
          currentPeriodEnd: subscription.currentPeriodEnd,
          gracePeriodEndsAt: subscription.gracePeriodEndsAt,
        }
      : null,
    usage: { ...usage, pendingInvitations },
    now,
  });
}
