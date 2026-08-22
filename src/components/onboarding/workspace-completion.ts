import type { OnboardingProgressSummary, OnboardingStepResult } from "@/lib/onboarding/progress";

/**
 * Stage 7.1.1 (Workspace Completion Experience). A pure presentation-layer
 * summary derived entirely from the existing Stage 2 progress contract
 * (src/lib/onboarding/progress.ts) — no new Prisma query, no new
 * persisted state, no change to how a step's status is computed. Mirrors
 * how step-row-actions.ts/should-render-card.ts already extract pure,
 * unit-testable view logic out of the components themselves rather than
 * inventing a second onboarding data source.
 *
 * The customer-facing headline/subheadline are intentionally the two
 * fixed strings this stage's own task specified — not tiered by percent —
 * since the card (OnboardingCard, via shouldRenderOnboardingCard) is only
 * ever visible while genuinely incomplete; "almost ready" holds at any
 * point along that range, and the percent number itself (already shown by
 * OnboardingProgressBar) is what conveys exactly how far along.
 */

export type WorkspaceCompletionSummary = {
  headline: string;
  subheadline: string;
  /** Real, substantive accomplishments only — WELCOME/FINISH are acknowledgments, not setup items, so they're excluded the same way SUBSTANTIVE_STEPS excludes them in progress.ts. Never capped: this is a celebratory list, not an action list. */
  completedSteps: OnboardingStepResult[];
  /**
   * The next steps actually worth doing right now — NOT_STARTED, not
   * blocked behind an unmet dependency, and with a real destination to
   * send someone to (WELCOME/FINISH have no targetHref and are excluded
   * by that same check, no special-casing needed). Capped at 3: this is a
   * short, motivating highlight, not a second copy of the full checklist
   * already rendered below it.
   */
  nextActions: OnboardingStepResult[];
};

const HEADLINE = "Your workspace is almost ready";
const SUBHEADLINE = "Complete setup to start using Client Portal.";

const MAX_NEXT_ACTIONS = 3;

export function getWorkspaceCompletionSummary(progress: OnboardingProgressSummary): WorkspaceCompletionSummary {
  const completedSteps = progress.steps.filter(
    (step) => step.key !== "WELCOME" && step.key !== "FINISH" && step.status === "COMPLETE",
  );

  const nextActions = progress.steps
    .filter((step) => step.status === "NOT_STARTED" && step.actionable && step.targetHref !== null)
    .slice(0, MAX_NEXT_ACTIONS);

  return {
    headline: HEADLINE,
    subheadline: SUBHEADLINE,
    completedSteps,
    nextActions,
  };
}
