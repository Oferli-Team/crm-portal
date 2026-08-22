import type { OnboardingStepKey } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { getCurrentUserOrganization } from "@/lib/current-user";
import {
  ONBOARDING_STEP_ORDER,
  getOnboardingStep,
  isOnboardingStepAvailable,
  type OnboardingStepDefinition,
} from "./steps";

/**
 * Onboarding Stage 2 (docs/onboarding-architecture.md §4/§9/§10/§14).
 * `buildOnboardingProgress` is pure — no I/O, no Prisma import reachable
 * from its own call graph, the same discipline `access-mode.ts`/
 * `entitlements.ts` already established for Billing. Every "done" check
 * for a computed step is a plain boolean the caller already resolved from
 * a cheap count/exists query (§13); this function never re-queries
 * anything, and never replays Activity (§9 Option D, rejected).
 */

export type OnboardingStepStatus = "NOT_STARTED" | "COMPLETE" | "SKIPPED" | "NOT_APPLICABLE";

export type OnboardingCompletionSource = "computed" | "acknowledged" | "skipped" | "not_applicable" | "none";

export type OnboardingStepResult = {
  key: OnboardingStepKey;
  label: string;
  status: OnboardingStepStatus;
  required: boolean;
  skippable: boolean;
  /** Only meaningful while status is NOT_STARTED — whether this step's own dependency (if any) is currently satisfied by real data. Always true for a step with no dependency. */
  actionable: boolean;
  /** Set only when NOT_STARTED and not actionable — reuses the exact existing empty-state copy for a dependency this app already messages elsewhere (§15), never new marketing text. */
  blockedReason: string | null;
  targetHref: string | null;
  completionSource: OnboardingCompletionSource;
};

export type OnboardingProgressSummary = {
  steps: OnboardingStepResult[];
  /**
   * The "N of M" display fraction — M excludes WELCOME (a greeting, not
   * an accomplishment) and excludes any currently-unavailable step (none,
   * as of Sale-Ready Phase E, E3.3 — `isOnboardingStepAvailable` no
   * longer excludes `REVIEW_BILLING`; this exclusion still exists in the
   * code for any *future* step that might genuinely need it), but DOES
   * include FINISH: seeing "9 of 10 — click Finish to wrap up" is a
   * deliberate, motivating last step, not a bookend to hide.
   */
  completedCount: number;
  totalCount: number;
  /** How many of the *required* steps (§1: Client, Project) are Complete — required steps are never Skipped (they're not skippable), so this never double-counts. */
  requiredCompleted: number;
  requiredTotal: number;
  /** 0–100, integer, `completedCount / totalCount` — see this module's own rounding note below. `0` for a fresh org (totalCount is always >= 1 on this branch, so this never divides by zero). */
  percent: number;
  /**
   * §3 path 1 — "every step is either done or skipped" — evaluated over
   * the *substantive* steps only (excludes WELCOME and FINISH, and any
   * unavailable step): whether there is genuinely nothing left to *do*,
   * independent of whether the user has ever clicked Finish. Deliberately
   * a different set than `percent`'s own denominator — see this file's
   * own `SUBSTANTIVE_STEPS` comment for why collapsing the two would wrongly
   * fold §3's two independent completion paths into one.
   */
  isComplete: boolean;
  /** §3 path 2 — a FINISH row exists for this organization. Independent of `isComplete`: a user can dismiss at 2 of 6, or reach 6 of 6 and never formally click Finish (rare, but not a contradiction — `isComplete` alone already means "no visible next step" either way). */
  isDismissed: boolean;
};

/** Already-resolved raw facts about one organization — every field here is a plain boolean/count/set the DB-backed loader below computes with cheap, already-indexed queries; this module's own pure function never re-derives any of them. */
export type OnboardingRawSignals = {
  hasClient: boolean;
  hasProject: boolean;
  hasTask: boolean;
  /** True once more than just the creating OWNER holds a Membership — an *accepted* teammate, never a merely-pending Invitation (docs/onboarding-architecture.md §4's own explicit `membership.count > 1` decision — see this stage's own research note on why a pending invite must never permanently satisfy this on its own). */
  hasSecondMember: boolean;
  /** True once a PortalUser row exists for any Client in this organization — created only on invitation *accept*, never on send (a ClientInvitation alone is not enough — see src/app/portal/invite/[token]/actions.ts). */
  hasPortalUser: boolean;
  /** Customer Setup Wizard (Stage 6.2): OrganizationProfile row exists (the OWNER submitted the Company Profile form at least once). */
  hasCompanyProfile: boolean;
  /** OrganizationPaymentDetails row exists. */
  hasPaymentDetails: boolean;
  /** OrganizationDomainSettings row exists — regardless of whether a custom domain was actually entered; confirming "I'll use the generated subdomain" is itself a complete way to finish this step. */
  hasDomainSettings: boolean;
  /** The set of step keys with an existing OrganizationOnboardingStep row for this organization — each one means either "explicitly skipped" (a skippable step) or "explicitly acknowledged" (WELCOME/FINISH), never both meanings for the same key (§9's own row-existence-is-the-whole-signal model). */
  actedStepKeys: ReadonlySet<OnboardingStepKey>;
};

/** Reused verbatim from the exact existing empty-state copy on the relevant list page (§15's own "never disagree with the empty state" rule) — never new text invented for this stage. */
const BLOCKED_REASONS: Partial<Record<OnboardingStepKey, string>> = {
  CREATE_PROJECT: "Projects must belong to a client. Add one before creating a project.",
  CREATE_TASK: "Tasks must belong to a project. Add one before creating a task.",
  // No existing page-level empty state covers this exact case (the real
  // Portal-invite flow lives inside a specific Client's own edit page, not
  // behind a list-page gate) — a plain, factual sentence, not copied from
  // anywhere, since nothing to copy exists.
  INVITE_PORTAL_USER: "Invite a Client Portal user once you have at least one client.",
};

function isStepDoneByData(key: OnboardingStepKey, signals: OnboardingRawSignals): boolean {
  switch (key) {
    case "COMPANY_PROFILE":
      return signals.hasCompanyProfile;
    case "PAYMENT_DETAILS":
      return signals.hasPaymentDetails;
    case "DOMAIN_SETUP":
      return signals.hasDomainSettings;
    case "CREATE_CLIENT":
      return signals.hasClient;
    case "CREATE_PROJECT":
      return signals.hasProject;
    case "CREATE_TASK":
      return signals.hasTask;
    case "INVITE_TEAMMATE":
      return signals.hasSecondMember;
    case "INVITE_PORTAL_USER":
      return signals.hasPortalUser;
    default:
      return false;
  }
}

/**
 * Steps counted toward `isComplete` (§3 path 1) — every substantive,
 * "something to actually do" step, available or not (an unavailable step
 * is simply never included at all — see the filter below). WELCOME and
 * FINISH are deliberately excluded: neither represents "something left to
 * do" in the sense §3 path 1 means.
 */
const SUBSTANTIVE_STEPS: readonly OnboardingStepKey[] = [
  "COMPANY_PROFILE",
  "PAYMENT_DETAILS",
  "DOMAIN_SETUP",
  "CREATE_CLIENT",
  "CREATE_PROJECT",
  "CREATE_TASK",
  "INVITE_TEAMMATE",
  "INVITE_PORTAL_USER",
  "REVIEW_BILLING",
];

export function buildOnboardingProgress(signals: OnboardingRawSignals): OnboardingProgressSummary {
  const resultsByKey = {} as Record<OnboardingStepKey, OnboardingStepResult>;

  // Processed in §5's own dependency-respecting order, so a step's own
  // dependency result (if any) is already computed by the time it's this
  // step's turn. `NOT_APPLICABLE` is unreachable for every current step key
  // (`isOnboardingStepAvailable` returns true for all of them, Sale-Ready
  // Phase E, E3.3) — kept as the one seam a genuinely-conditional future
  // step would use, same as `isOnboardingStepAvailable`'s own comment notes.
  for (const key of ONBOARDING_STEP_ORDER) {
    const def = getOnboardingStep(key);
    resultsByKey[key] = buildStepResult(def, signals, resultsByKey);
  }

  const orderedResults = ONBOARDING_STEP_ORDER.map((key) => resultsByKey[key]);

  const percentEligible = orderedResults.filter(
    (r) => r.key !== "WELCOME" && r.status !== "NOT_APPLICABLE",
  );
  const completedCount = percentEligible.filter((r) => r.status === "COMPLETE" || r.status === "SKIPPED").length;
  const totalCount = percentEligible.length;
  const percent = totalCount === 0 ? 0 : Math.round((completedCount / totalCount) * 100);

  const requiredResults = orderedResults.filter((r) => r.required);
  const requiredCompleted = requiredResults.filter((r) => r.status === "COMPLETE").length;

  const substantiveResults = orderedResults.filter(
    (r) => SUBSTANTIVE_STEPS.includes(r.key) && r.status !== "NOT_APPLICABLE",
  );
  const isComplete =
    substantiveResults.length > 0 &&
    substantiveResults.every((r) => r.status === "COMPLETE" || r.status === "SKIPPED");

  const isDismissed = resultsByKey.FINISH.status === "COMPLETE";

  return {
    steps: orderedResults,
    completedCount,
    totalCount,
    requiredCompleted,
    requiredTotal: requiredResults.length,
    percent,
    isComplete,
    isDismissed,
  };
}

function buildStepResult(
  def: OnboardingStepDefinition,
  signals: OnboardingRawSignals,
  priorResults: Partial<Record<OnboardingStepKey, OnboardingStepResult>>,
): OnboardingStepResult {
  const base = {
    key: def.key,
    label: def.label,
    required: def.required,
    skippable: def.skippable,
    targetHref: def.targetHref,
  };

  if (!isOnboardingStepAvailable(def.key)) {
    // Unavailable overrides everything else, unconditionally — even a
    // stray row would never flip this back to Skipped/Complete. As of
    // Sale-Ready Phase E, E3.3, isOnboardingStepAvailable() returns true
    // for every current step key, so this branch is unreachable today —
    // kept as the one seam a genuinely-conditional future step would use.
    return {
      ...base,
      status: "NOT_APPLICABLE",
      actionable: false,
      blockedReason: null,
      completionSource: "not_applicable",
    };
  }

  const acted = signals.actedStepKeys.has(def.key);

  if (def.computed) {
    if (isStepDoneByData(def.key, signals)) {
      return { ...base, status: "COMPLETE", actionable: false, blockedReason: null, completionSource: "computed" };
    }
    if (def.skippable && acted) {
      return { ...base, status: "SKIPPED", actionable: false, blockedReason: null, completionSource: "skipped" };
    }
    // NOT_STARTED — resolve actionability from the dependency chain.
    const depKey = def.dependsOn;
    const depResult = depKey ? priorResults[depKey] : undefined;
    const dependencySatisfied = !depKey || depResult?.status === "COMPLETE";
    return {
      ...base,
      status: "NOT_STARTED",
      actionable: dependencySatisfied,
      blockedReason: dependencySatisfied ? null : (BLOCKED_REASONS[def.key] ?? null),
      completionSource: "none",
    };
  }

  // Non-computed: there is no business-data signal, so the only possible
  // states are Not Started and one of two "acted" outcomes. WELCOME/
  // FINISH are never skippable (§6), so an acted row for either always
  // means Complete-by-acknowledgment. REVIEW_BILLING (Sale-Ready Phase E,
  // E3.3) is the one non-computed step that IS skippable — an acted row
  // for it must resolve to Skipped, not Complete, exactly like a
  // computed-but-skipped step above (`def.skippable && acted` there);
  // otherwise clicking "Skip" would show the same green checkmark as
  // actually reviewing the page, which OnboardingStepIcon renders as a
  // visually distinct (and semantically different) state from Skipped on
  // purpose. This branch is still unreachable for WELCOME/FINISH either
  // way, since `def.skippable` is `false` for both.
  if (acted) {
    return def.skippable
      ? { ...base, status: "SKIPPED", actionable: false, blockedReason: null, completionSource: "skipped" }
      : { ...base, status: "COMPLETE", actionable: false, blockedReason: null, completionSource: "acknowledged" };
  }
  return { ...base, status: "NOT_STARTED", actionable: true, blockedReason: null, completionSource: "none" };
}

/**
 * The single DB-backed entry point every future caller (Stage 3's own UI,
 * Stage 4's dashboard card) should use — mirrors
 * `getOrganizationEntitlements()`'s own "one function, one call site"
 * shape from Billing. `organizationId` is always caller-resolved
 * server-side (§6/§13) — this function itself does no session/cookie
 * resolution, exactly like `getOrganizationEntitlements` doesn't either.
 *
 * Every query here is a bounded count/exists check, run concurrently via
 * one `Promise.all` (§13) — no N+1, no full-row loads where only a
 * boolean is needed, one organization per call.
 */
export async function getOrganizationOnboardingProgress(organizationId: string): Promise<OnboardingProgressSummary> {
  const [
    clientCount,
    projectCount,
    taskCount,
    membershipCount,
    portalUserCount,
    hasCompanyProfileRow,
    hasPaymentDetailsRow,
    hasDomainSettingsRow,
    actedRows,
  ] = await Promise.all([
    prisma.client.count({ where: { organizationId } }),
    prisma.project.count({ where: { organizationId } }),
    prisma.task.count({ where: { organizationId } }),
    prisma.membership.count({ where: { organizationId } }),
    prisma.portalUser.count({ where: { client: { organizationId } } }),
    prisma.organizationProfile.findUnique({ where: { organizationId }, select: { organizationId: true } }),
    prisma.organizationPaymentDetails.findUnique({ where: { organizationId }, select: { organizationId: true } }),
    prisma.organizationDomainSettings.findUnique({ where: { organizationId }, select: { organizationId: true } }),
    prisma.organizationOnboardingStep.findMany({
      where: { organizationId },
      select: { step: true },
    }),
  ]);

  const signals: OnboardingRawSignals = {
    hasClient: clientCount > 0,
    hasProject: projectCount > 0,
    hasTask: taskCount > 0,
    hasCompanyProfile: hasCompanyProfileRow !== null,
    hasPaymentDetails: hasPaymentDetailsRow !== null,
    hasDomainSettings: hasDomainSettingsRow !== null,
    hasSecondMember: membershipCount > 1,
    hasPortalUser: portalUserCount > 0,
    actedStepKeys: new Set(actedRows.map((r) => r.step)),
  };

  return buildOnboardingProgress(signals);
}

/**
 * Convenience wrapper for a future Stage 3 page/component: resolves the
 * caller's own active organization server-side
 * (`getCurrentUserOrganization()`, the same function every other
 * dashboard read already uses) rather than accepting one as a parameter —
 * so a caller can never read another organization's progress, forged
 * cookie or not (§6: `resolveActiveOrganizationId` only ever returns an
 * organizationId backed by a real Membership row for the current user).
 */
export async function getCurrentOrganizationOnboardingProgress(): Promise<OnboardingProgressSummary> {
  const { organizationId } = await getCurrentUserOrganization();
  return getOrganizationOnboardingProgress(organizationId);
}
