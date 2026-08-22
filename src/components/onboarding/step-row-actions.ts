import type { OnboardingStepResult } from "@/lib/onboarding/progress";
import { ONBOARDING_STEP_DESCRIPTIONS } from "./step-copy";

export type OnboardingStepRowActions = {
  isBlocked: boolean;
  showGoTo: boolean;
  showSkip: boolean;
  description: string;
  /**
   * Stage 6 audit fix: applied ONLY to the row's own decorative icon
   * (aria-hidden, already redundant with the status badge + description
   * text) — never to the label or description. The original Blocked
   * treatment dimmed a wrapper containing the explanatory text too, which
   * measured at ~2.3:1 contrast for the description (text-gray-500 at 60%
   * opacity), well under WCAG AA's 4.5:1 minimum for normal text. Blocked
   * is still visually distinct without it: a different (dimmed) icon, the
   * blocked-reason copy itself, and the absent "Go to" button are already
   * three non-color signals together (never color-only).
   */
  iconWrapperClassName: string;
};

/**
 * Pure action-visibility rules for one step row (Stage 3 task §6/§9),
 * extracted out of OnboardingStepRow so this decision logic is unit-testable
 * without rendering React — mirrors how buildOnboardingProgress
 * (src/lib/onboarding/progress.ts) is kept pure and separate from its own
 * DB-backed caller. See OnboardingStepRow's own comment for the full
 * reasoning behind each rule, including why WELCOME/FINISH need no
 * special-casing here.
 */
export function getOnboardingStepRowActions(step: OnboardingStepResult): OnboardingStepRowActions {
  const isBlocked = step.status === "NOT_STARTED" && !step.actionable;
  const showGoTo = step.status === "NOT_STARTED" && step.actionable && step.targetHref !== null;
  const showSkip = step.status === "NOT_STARTED" && step.skippable;
  const description = isBlocked && step.blockedReason ? step.blockedReason : ONBOARDING_STEP_DESCRIPTIONS[step.key];
  const iconWrapperClassName = isBlocked ? "opacity-60" : "";

  return { isBlocked, showGoTo, showSkip, description, iconWrapperClassName };
}
