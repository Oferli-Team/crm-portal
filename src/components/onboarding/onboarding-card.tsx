import { OnboardingProgressBar } from "./onboarding-progress-bar";
import { OnboardingStepRow } from "./onboarding-step-row";
import { DismissOnboardingButton } from "./dismiss-onboarding-button";
import { WorkspaceCompletionSummary } from "./workspace-completion-summary";
import { shouldRenderOnboardingCard } from "./should-render-card";
import { getWorkspaceCompletionSummary } from "./workspace-completion";
import type { OnboardingProgressSummary } from "@/lib/onboarding/progress";

/**
 * Stage 5 polish — the id of the Dashboard page's own `<h1>`
 * ((dashboard)/dashboard/page.tsx), which must carry this exact id and
 * `tabIndex={-1}` for DismissOnboardingButton's own focus-return to have
 * somewhere real to land once this whole card unmounts. Exported (not a
 * private string duplicated in two files) so the two call sites can never
 * drift out of sync.
 */
export const ONBOARDING_DISMISS_RETURN_FOCUS_ID = "dashboard-heading";

/**
 * Stage 3 task §2/§3/§4/§11. An ordinary Dashboard card — never a wizard,
 * modal, full page, or blocking overlay (docs/onboarding-architecture.md
 * §11) — visually consistent with the bordered-card treatment every other
 * dashboard section already uses. Renders only on `/dashboard`
 * ((dashboard)/dashboard/page.tsx passes the progress summary in) —
 * absent everywhere else by construction, since nothing else imports it.
 *
 * Visibility (§4): completely absent, not collapsed/hidden-via-CSS, once
 * dismissed or complete.
 *
 * Mobile (§15): no separate mobile component — the same responsive
 * flex/stack rules in this file and OnboardingStepRow reflow the header,
 * progress bar, and each row at every breakpoint down to 320px, the same
 * "one component adapts its own layout" philosophy Sidebar/NotificationBell
 * already use, rather than introducing a second collapse/expand
 * interaction not covered by this stage's own action list (§9).
 */
export function OnboardingCard({ progress }: { progress: OnboardingProgressSummary }) {
  if (!shouldRenderOnboardingCard(progress)) {
    return null;
  }

  // Stage 7.1.1 — a pure presentational reduction of the same `progress`
  // already computed above; no new query, no new persisted state (see
  // workspace-completion.ts's own header comment).
  const completion = getWorkspaceCompletionSummary(progress);

  return (
    <section aria-labelledby="onboarding-heading" className="rounded-lg border border-gray-200 bg-white p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="onboarding-heading" className="text-lg font-semibold tracking-tight text-gray-900">
            Getting started
          </h2>
          <p className="mt-1 text-sm font-medium text-gray-900">{completion.headline}</p>
          <p className="mt-0.5 text-sm text-gray-600">{completion.subheadline}</p>
        </div>
        <DismissOnboardingButton returnFocusId={ONBOARDING_DISMISS_RETURN_FOCUS_ID} />
      </div>

      {/* Live region: a step flipping to Done (e.g. a Client created in
          another tab) after a skip/dismiss revalidation is announced to
          screen readers the same way toast-provider.tsx's own region
          already announces toasts (docs/onboarding-architecture.md §12).
          The Stage 7.1.1 completed/next-up summary lives in here too —
          it's derived from the same live data as the bar itself. */}
      <div className="mt-4" aria-live="polite">
        <OnboardingProgressBar
          completedCount={progress.completedCount}
          totalCount={progress.totalCount}
          percent={progress.percent}
        />
        <WorkspaceCompletionSummary summary={completion} />
      </div>

      <ul className="mt-6 divide-y divide-gray-200">
        {progress.steps.map((step) => (
          <li key={step.key} className="py-4 first:pt-0 last:pb-0">
            <OnboardingStepRow step={step} />
          </li>
        ))}
      </ul>
    </section>
  );
}
