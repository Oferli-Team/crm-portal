/**
 * Billing & Subscriptions Stage 2 (docs/billing-architecture.md §6, refined
 * by this stage's own exact instructions). The single, typed, compile-time
 * plan catalog — no `Plan` table, no provider price IDs anywhere in this
 * file. Every number here is an explicit product-config placeholder for
 * this stage, not a committed pricing decision (see docs/billing-
 * architecture.md §3's own disclaimer) — changing one is a code review +
 * deploy, never a runtime database edit. Provider price IDs are Stage 3+'s
 * concern, sourced from env vars at that point, never hardcoded here.
 */

export type PlanKey = "TRIAL" | "STARTER" | "PRO" | "LEGACY";

export type PlanLimits = {
  /** Always a concrete ceiling — this app's staff-seat cost is real at every plan, including LEGACY (see that plan's own comment). */
  maxMembers: number;
  /** `null` means unlimited. */
  maxClients: number | null;
  /** `null` means unlimited. */
  maxProjects: number | null;
  /** Always a concrete ceiling in bytes — see LEGACY's own comment for why "unlimited" is still expressed as a real number here. */
  maxStorageBytes: number;
};

export type Plan = {
  key: PlanKey;
  displayName: string;
  limits: PlanLimits;
  /** Non-null only for TRIAL. */
  trialDays: number | null;
  /** Whether this plan can ever be the target of a real checkout (Stage 3+) — false for TRIAL/LEGACY, which are never purchased. */
  billingAvailable: boolean;
};

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const TRIAL_DURATION_DAYS = 14;

/**
 * Two paid tiers + one trial tier + one internal-only legacy tier —
 * deliberately not more (docs/billing-architecture.md §3 explicitly warns
 * against over-fragmenting the tier list). TRIAL mirrors PRO's limits (the
 * design doc's own "trial mirrors Pro" decision), so a trialing org never
 * hits an artificial ceiling before it's even chosen a plan.
 */
export const PLAN_CATALOG: Readonly<Record<PlanKey, Plan>> = {
  TRIAL: {
    key: "TRIAL",
    displayName: "Trial",
    limits: { maxMembers: 5, maxClients: null, maxProjects: null, maxStorageBytes: 10 * GB },
    trialDays: TRIAL_DURATION_DAYS,
    billingAvailable: false,
  },
  STARTER: {
    key: "STARTER",
    displayName: "Starter",
    limits: { maxMembers: 1, maxClients: 10, maxProjects: 20, maxStorageBytes: 500 * MB },
    trialDays: null,
    billingAvailable: true,
  },
  PRO: {
    key: "PRO",
    displayName: "Pro",
    limits: { maxMembers: 5, maxClients: null, maxProjects: null, maxStorageBytes: 10 * GB },
    trialDays: null,
    billingAvailable: true,
  },
  // Pre-billing organizations (created before this stage shipped, and
  // optionally backfilled by prisma/backfill-subscriptions.ts — never
  // auto-created by this stage's own migration). Never sold, never
  // choosable by a user in any UI — a fixed, generous ceiling rather than
  // a literal "unlimited" so every consumer of PlanLimits can stay a plain
  // number comparison with no special-cased null-means-infinite branch for
  // this one plan alone.
  LEGACY: {
    key: "LEGACY",
    displayName: "Legacy (pre-billing)",
    limits: { maxMembers: 1000, maxClients: null, maxProjects: null, maxStorageBytes: 1024 * GB },
    trialDays: null,
    billingAvailable: false,
  },
} as const;

export const DEFAULT_TRIAL_PLAN_KEY: PlanKey = "TRIAL";
export const LEGACY_PLAN_KEY: PlanKey = "LEGACY";

export function getPlan(key: PlanKey): Plan {
  return PLAN_CATALOG[key];
}

export function isPlanKey(value: string): value is PlanKey {
  return Object.prototype.hasOwnProperty.call(PLAN_CATALOG, value);
}

/** Every PlanKey, for exhaustive iteration (catalog-consistency tests, etc.) — never mutated, never used to build a Prisma enum. */
export const ALL_PLAN_KEYS: readonly PlanKey[] = Object.keys(PLAN_CATALOG) as PlanKey[];
