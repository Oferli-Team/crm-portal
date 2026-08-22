import Link from "next/link";
import { StatusBadge } from "@/components/ui/status-badge";
import { OnboardingStepIcon } from "./onboarding-step-icon";
import { SkipStepButton } from "./skip-step-button";
import { getOnboardingStepRowActions } from "./step-row-actions";
import type { OnboardingStepResult } from "@/lib/onboarding/progress";

/**
 * Stage 3 task §6/§9. Action rules, derived directly from the Stage 2
 * contract (src/lib/onboarding/progress.ts), never invented separately:
 * - COMPLETE / NOT_APPLICABLE: no button (§9).
 * - NOT_STARTED, blocked (`actionable: false`): show `blockedReason`
 *   instead of the normal description; no buttons — skip is still offered
 *   if `skippable`, matching the Stage 2 skip action's own contract (it has
 *   no dependency check).
 * - NOT_STARTED, actionable: a "Go to" link when `targetHref` exists, and a
 *   "Skip" button when `skippable` — independent, both can show together.
 * - SKIPPED: no button. Un-skipping only ever happens by doing the real
 *   thing elsewhere in the app (§9's "stale row is harmless dead data"
 *   stance) — this card has nothing to un-skip it with directly.
 * WELCOME/FINISH naturally get no action button: both have `targetHref:
 * null` and `skippable: false`, so the two conditions above simply never
 * trigger for them — no special-casing needed.
 */
/** Stable per-row id: unique across the fixed 8-step catalog, unaffected by re-ordering elsewhere on the page — used only as a Stage 5 focus-return target for this row's own Skip button. */
function stepLabelId(key: string): string {
  return `onboarding-step-${key}`;
}

export function OnboardingStepRow({ step }: { step: OnboardingStepResult }) {
  const { showGoTo, showSkip, description, iconWrapperClassName } = getOnboardingStepRowActions(step);
  const labelId = stepLabelId(step.key);

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      {/* Blocked rows are visually dimmed (docs/onboarding-architecture.md
          §10's own "Blocked — grayed" state) — but ONLY the decorative
          icon (Stage 6 audit fix). Dimming used to also cover the label
          and blocked-reason text, which pushed the description
          (text-gray-500) to ~2.3:1 contrast, under WCAG AA's 4.5:1
          minimum for normal text — see step-row-actions.ts's own comment.
          Label/description stay full-strength; the icon + the copy itself
          + the absent "Go to" button remain three non-color signals for
          Blocked, so nothing about "distinct without color alone" is lost. */}
      <div className="flex items-start gap-3">
        <div className={iconWrapperClassName}>
          <OnboardingStepIcon status={step.status} />
        </div>
        <div>
          {/* Stage 6 audit fix: this label is a focus-return target after a
              successful Skip (SkipStepButton below) — previously
              `focus:outline-none` with no replacement, so a sighted
              keyboard user lost all visual track of where focus landed.
              Plain `focus:` (not `focus-visible:`) is deliberate: this
              element is never part of the natural tab order (tabIndex=-1,
              only ever focused programmatically), so there's no "ring
              after a mouse click" case to avoid — using `:focus-visible`
              here would depend on browser/automation heuristics for
              programmatic focus that aren't guaranteed consistent, where
              plain `:focus` always matches deterministically whenever
              `.focus()` is called. */}
          <p
            id={labelId}
            tabIndex={-1}
            className="rounded text-sm font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-black focus:ring-offset-2"
          >
            {step.label}
          </p>
          <p className="mt-0.5 text-sm text-gray-500">{description}</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:pl-3">
        <StatusBadge status={step.status} />
        {showGoTo && step.targetHref && (
          <Link
            href={step.targetHref}
            aria-label={`Go to: ${step.label}`}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
          >
            Go to
          </Link>
        )}
        {showSkip && <SkipStepButton stepKey={step.key} label={step.label} returnFocusId={labelId} />}
      </div>
    </div>
  );
}
