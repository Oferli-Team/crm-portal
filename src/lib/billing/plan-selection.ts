import { isPlanKey, PLAN_CATALOG, type PlanKey } from "./plans";

/**
 * Billing & Subscriptions Stage 3. A plan is a valid *purchase target* only
 * if it's both a real PlanKey and marked `billingAvailable` — TRIAL/LEGACY
 * are real PlanKeys (isPlanKey alone would accept them) but are never
 * purchasable (this stage's own §7: "cards for Starter and Pro only").
 * Single source of truth for requestPlanChangeAction's own validation, so
 * the action and this module's unit tests exercise the exact same check.
 */
export function isPurchasablePlanKey(value: string): value is PlanKey {
  return isPlanKey(value) && PLAN_CATALOG[value].billingAvailable;
}
