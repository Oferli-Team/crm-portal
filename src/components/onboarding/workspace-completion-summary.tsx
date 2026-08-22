import type { WorkspaceCompletionSummary as WorkspaceCompletionSummaryData } from "./workspace-completion";

/**
 * Stage 7.1.1. Purely additive to OnboardingCard — no new interactive
 * elements (no new links/buttons), so there is nothing here for a Skip/Go
 * to click to duplicate or conflict with the existing per-step rows below.
 * Deliberately plain, single-text-node paragraphs — never a `<ul>`/`<li>`
 * (OnboardingCard's own step list is the one accessible "list" this card
 * exposes; test/e2e/onboarding-ui.spec.ts asserts exactly 11 listitems),
 * and never a nested `<span>` splitting the "label:" prefix from its own
 * content (a nested element would give text-matching queries like
 * `getByText(/^Up next:/)` two overlapping candidates — the prefix span
 * and the whole paragraph — for a single logical line). Joining each set
 * of step labels into one sentence also means a step's own bare label is
 * never a second, ambiguous exact-text match for an assertion targeting
 * that step's real row below.
 */
export function WorkspaceCompletionSummary({ summary }: { summary: WorkspaceCompletionSummaryData }) {
  const { completedSteps, nextActions } = summary;

  if (completedSteps.length === 0 && nextActions.length === 0) {
    return null;
  }

  return (
    <div className="mt-3 space-y-1 text-sm text-gray-600">
      {completedSteps.length > 0 && (
        <p>{`Completed so far: ${completedSteps.map((step) => step.label).join(", ")}.`}</p>
      )}
      {nextActions.length > 0 && <p>{`Up next: ${nextActions.map((step) => step.label).join(", ")}.`}</p>}
    </div>
  );
}
