import type { OnboardingProgressSummary } from "@/lib/onboarding/progress";

/**
 * Stage 3 task §4 — the card is fully absent (not collapsed, not
 * hidden-via-CSS) once dismissed or complete. Extracted as a pure function
 * so OnboardingCard's visibility rule is unit-testable directly.
 */
export function shouldRenderOnboardingCard(progress: OnboardingProgressSummary): boolean {
  return !progress.isDismissed && !progress.isComplete;
}
