import type { OnboardingStepKey } from "@/generated/prisma/enums";

/**
 * Onboarding Stage 2 (docs/onboarding-architecture.md §5/§6/§9/§14). The
 * one, fixed, typed catalog every backend/UI piece reads step metadata
 * from — the Prisma `OnboardingStepKey` enum (schema.prisma) is the DB
 * column's own type; this catalog is the separate, code-side "what does
 * this step mean" contract, mirroring how `src/lib/billing/plans.ts`'s
 * `PLAN_CATALOG` sits next to (never inside) a Prisma enum. Nothing here
 * is a schema change — adding/reordering a step's *metadata* is a code
 * review, never a migration (the step *keys* themselves are the one part
 * of this that IS schema-fixed, per the design doc's own explicit
 * `enum OnboardingStepKey` decision).
 */

/**
 * docs/onboarding-architecture.md §5's original order, with three new
 * steps (Customer Setup Wizard, Stage 6.2) inserted between WELCOME and
 * CREATE_CLIENT: initial workspace setup (company profile, payment
 * receiving details, domain preparation) happens before a user starts
 * putting business data in, matching the signup -> setup -> dashboard
 * flow this stage was asked to build. None of the three has a dependency
 * on the others or on Client/Project/Task — a user may complete them in
 * any order, or skip Payment/Domain entirely and come back later.
 */
export const ONBOARDING_STEP_ORDER: readonly OnboardingStepKey[] = [
  "WELCOME",
  "COMPANY_PROFILE",
  "PAYMENT_DETAILS",
  "DOMAIN_SETUP",
  "CREATE_CLIENT",
  "CREATE_PROJECT",
  "CREATE_TASK",
  "INVITE_TEAMMATE",
  "INVITE_PORTAL_USER",
  "REVIEW_BILLING",
  "FINISH",
];

export type OnboardingStepDefinition = {
  key: OnboardingStepKey;
  /** Position in the checklist — §5's decided order, 0-indexed. */
  order: number;
  /** A short, factual label — the same step names §4/§5 of the design doc already use, not marketing copy. Stage 3's UI owns tone/styling; this is the one piece of display-safe text this stage's own backend contract is authorized to return (§5's own "title key / display-safe metadata, if the architecture doc allows it"). */
  label: string;
  /**
   * Whether this step's "done" state is computed live from real business
   * data (§4/§9 Option A) rather than ever persisted as a row in
   * `OrganizationOnboardingStep`. WELCOME/FINISH are never computed —
   * acknowledging either is the *only* thing that can ever mark them done,
   * so they always go through the persisted (row-existence) path.
   * REVIEW_BILLING is `computed: false` here too, and stays that way even
   * now that it's available (Sale-Ready Phase E, E3.3) — deliberately: the
   * original design's two candidate "done by data" signals ("has viewed
   * /settings/billing at least once" and "has an active, non-trial plan")
   * either need a new persisted visit-flag (a schema change E3.3's own
   * scope explicitly excludes) or would leave this step permanently
   * incomplete for any organization that hasn't gone through a real
   * Paddle checkout — which most buyer deployments won't have, especially
   * before Paddle is even configured. `computed: false` here means
   * "reviewed" is exactly what it already is for WELCOME/FINISH: an
   * explicit acknowledgment (via `skipOnboardingStepAction`, since this
   * step's own `skippable: true` below), never gated on any billing
   * state — see `isOnboardingStepAvailable` below and this file's own
   * `buildStepResult`-adjacent notes in `progress.ts`.
   */
  computed: boolean;
  /** Whether a member may explicitly mark this step skipped (§6) — never means "blocking" either way (§6's own "no explicit Skip button does not mean blocking" rule). */
  skippable: boolean;
  /** Whether this step is load-bearing for a "productive first session" (§1) — feeds `requiredCompleted` in the progress summary; never used to block navigation (§0.5/§1's "never block, gate, or interrupt" goal). */
  required: boolean;
  /** The step this one is naturally blocked behind until real dependency data exists (§10/§14) — `null` if none. Only ever consulted for a step that is not yet Done/Skipped (§14: a step already Done from real data is never re-evaluated as blocked, regardless of its dependency's own current state). */
  dependsOn: OnboardingStepKey | null;
  /**
   * Where this step's own primary action lives — a real, existing route
   * only (§14's "No invented routes" rule), or `null` when there is no
   * single fixed destination (WELCOME/FINISH are actions, not
   * navigations; INVITE_PORTAL_USER has no single generic route since the
   * real flow is nested under a specific Client's own edit page, so this
   * points at the Clients list — see this file's own comment on that
   * field below; REVIEW_BILLING now points at the real `/settings/billing`
   * page, Sale-Ready Phase E, E3.3 — that page renders for every staff
   * role and stays fully safe with no Paddle configured at all, see
   * `docs/onboarding-architecture.md` §16's own "Current state" note).
   */
  targetHref: string | null;
};

export const ONBOARDING_STEPS: Readonly<Record<OnboardingStepKey, OnboardingStepDefinition>> = {
  WELCOME: {
    key: "WELCOME",
    order: 0,
    label: "Welcome",
    computed: false,
    skippable: false,
    required: false,
    dependsOn: null,
    targetHref: null,
  },
  // Customer Setup Wizard (Stage 6.2). Load-bearing the same way Client/
  // Project already are (§1's "productive first session" — a workspace's
  // own identity is as foundational as its first business data): no
  // explicit Skip button, but never blocking navigation either, exactly
  // like Client/Project already don't block (§6's own "no Skip button
  // does not mean blocking" rule).
  COMPANY_PROFILE: {
    key: "COMPANY_PROFILE",
    order: 1,
    label: "Set up your company profile",
    computed: true,
    skippable: false,
    required: true,
    dependsOn: null,
    targetHref: "/settings/company",
  },
  // Deferred/optional, matching this stage's own explicit "no Stripe/
  // payment processing yet" scope — real payment collection is a later
  // concern, entering *where to receive* money is not mandatory today.
  PAYMENT_DETAILS: {
    key: "PAYMENT_DETAILS",
    order: 2,
    label: "Add payment receiving details",
    computed: true,
    skippable: true,
    required: false,
    dependsOn: null,
    targetHref: "/settings/payment",
  },
  // Deferred/optional, matching this stage's own explicit "no real custom
  // domain verification yet" scope — the generated subdomain already
  // works with zero action from the user.
  DOMAIN_SETUP: {
    key: "DOMAIN_SETUP",
    order: 3,
    label: "Review your domain settings",
    computed: true,
    skippable: true,
    required: false,
    dependsOn: null,
    targetHref: "/settings/domain",
  },
  CREATE_CLIENT: {
    key: "CREATE_CLIENT",
    order: 4,
    label: "Create your first client",
    computed: true,
    skippable: false,
    required: true,
    dependsOn: null,
    targetHref: "/clients/new",
  },
  CREATE_PROJECT: {
    key: "CREATE_PROJECT",
    order: 5,
    label: "Create your first project",
    computed: true,
    skippable: false,
    required: true,
    dependsOn: "CREATE_CLIENT",
    targetHref: "/projects/new",
  },
  CREATE_TASK: {
    key: "CREATE_TASK",
    order: 6,
    label: "Create your first task",
    computed: true,
    skippable: true,
    required: false,
    dependsOn: "CREATE_PROJECT",
    targetHref: "/tasks/new",
  },
  INVITE_TEAMMATE: {
    key: "INVITE_TEAMMATE",
    order: 7,
    label: "Invite a teammate",
    computed: true,
    skippable: true,
    required: false,
    dependsOn: null,
    targetHref: "/team",
  },
  INVITE_PORTAL_USER: {
    key: "INVITE_PORTAL_USER",
    order: 8,
    label: "Invite a Client Portal user",
    computed: true,
    skippable: true,
    required: false,
    dependsOn: "CREATE_CLIENT",
    // No single generic "invite a portal user" route exists — that flow
    // lives under a specific Client's own /clients/[id]/edit Portal
    // Access section (docs/onboarding-architecture.md §0.3). Pointing at
    // the Clients list (a real, existing route) rather than inventing one
    // is the honest target: pick a client, then invite from there.
    targetHref: "/clients",
  },
  REVIEW_BILLING: {
    key: "REVIEW_BILLING",
    order: 9,
    label: "Review billing",
    computed: false,
    skippable: true,
    required: false,
    dependsOn: null,
    // Sale-Ready Phase E, E3.3: now that billing is fully implemented and
    // this step is available (see isOnboardingStepAvailable below), this
    // points at the real, existing /settings/billing page — every staff
    // role (OWNER/ADMIN/MEMBER) can view it, and it renders safely with
    // no Paddle account configured at all (getBillingProviderAvailability()
    // reports `configured: false`, the page shows the same "not
    // configured" state it always would — no crash, no secret, no forced
    // checkout).
    targetHref: "/settings/billing",
  },
  FINISH: {
    key: "FINISH",
    order: 10,
    label: "Finish setup",
    computed: false,
    skippable: false,
    required: false,
    dependsOn: null,
    targetHref: null,
  },
};

export const ALL_ONBOARDING_STEP_KEYS: readonly OnboardingStepKey[] = ONBOARDING_STEP_ORDER;

export function getOnboardingStep(key: OnboardingStepKey): OnboardingStepDefinition {
  return ONBOARDING_STEPS[key];
}

/**
 * True for every step (Sale-Ready Phase E, E3.3). This was originally the
 * one seam this catalog built for a billing integration that hadn't
 * merged yet — a single, explicit, hardcoded `false` for `REVIEW_BILLING`
 * (never a feature flag read from an env var, never an import of
 * anything under `src/lib/billing`, per the original "don't pull the
 * Billing branch in" constraint). Billing has since fully merged and is
 * live (E1–E2.6), and this function now reflects that: every step,
 * including `REVIEW_BILLING`, is available. Deliberately still
 * unconditional rather than deleted — it remains the one, single seam
 * every future step's availability would go through, so a step that
 * genuinely does need to be conditionally hidden later has exactly one
 * function to change, matching this catalog's own "one seam, not
 * scattered checks" precedent.
 */
export function isOnboardingStepAvailable(key: OnboardingStepKey): boolean {
  void key;
  return true;
}

/** A fixed allowlist of every href this catalog can ever point at — real, existing routes only, checked by this module's own unit tests and by the security check. */
export const ONBOARDING_STEP_HREF_ALLOWLIST: readonly string[] = [
  "/settings/company",
  "/settings/payment",
  "/settings/domain",
  "/settings/billing",
  "/clients/new",
  "/projects/new",
  "/tasks/new",
  "/team",
  "/clients",
];
