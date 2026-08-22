/**
 * Analytics Stage 1. `0` (never `NaN`) when `total` is `0` — an
 * organization with zero tasks/invoices has trivially completed none of
 * them, not an undefined rate. Rounded to the nearest integer, matching
 * src/lib/onboarding/progress.ts's own `percent` field shape.
 */
export function calculateCompletionRate(completed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((completed / total) * 100);
}

/**
 * `null` — never `Infinity`/`NaN` — when `previousPeriodCount` is `0`:
 * "grew from zero" has no finite percentage, and a UI showing `Infinity%`
 * or `null` rendered as `NaN%` would be worse than an explicit "no prior
 * data" state the caller can render deliberately. Otherwise rounded to
 * the nearest integer percent, matching `calculateCompletionRate`.
 */
export function calculateGrowthRate(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}
