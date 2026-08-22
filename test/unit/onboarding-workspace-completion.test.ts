import { describe, expect, it } from "vitest";
import { buildOnboardingProgress, type OnboardingRawSignals } from "@/lib/onboarding/progress";
import { getWorkspaceCompletionSummary } from "@/components/onboarding/workspace-completion";
import type { OnboardingStepKey } from "@/generated/prisma/enums";

/**
 * Stage 7.1.1 (Workspace Completion Experience). Same fixture pattern as
 * test/unit/onboarding-ui.test.ts — real step results come from the
 * already-tested buildOnboardingProgress, never hand-built, so these tests
 * exercise the real Stage 2 contract shape. getWorkspaceCompletionSummary
 * is a pure reduction over that contract (no I/O, no new persisted
 * state) — these tests cover exactly what this stage's own task asked
 * for: fresh signup, partially completed, and fully completed states.
 */

function signals(overrides: Partial<OnboardingRawSignals> = {}): OnboardingRawSignals {
  return {
    hasClient: false,
    hasProject: false,
    hasTask: false,
    hasSecondMember: false,
    hasPortalUser: false,
    hasCompanyProfile: false,
    hasPaymentDetails: false,
    hasDomainSettings: false,
    actedStepKeys: new Set<OnboardingStepKey>(),
    ...overrides,
  };
}

describe("getWorkspaceCompletionSummary", () => {
  it("always returns the two fixed, customer-facing headline/subheadline strings", () => {
    const summary = getWorkspaceCompletionSummary(buildOnboardingProgress(signals()));
    expect(summary.headline).toBe("Your workspace is almost ready");
    expect(summary.subheadline).toBe("Complete setup to start using Client Portal.");
  });

  it("fresh signup: no completed steps, and the next actions are the first (up to 3) unblocked, actionable steps in catalog order", () => {
    const progress = buildOnboardingProgress(signals());
    const summary = getWorkspaceCompletionSummary(progress);

    expect(summary.completedSteps).toEqual([]);
    expect(summary.nextActions.map((s) => s.key)).toEqual(["COMPANY_PROFILE", "PAYMENT_DETAILS", "DOMAIN_SETUP"]);
    // CREATE_CLIENT is actionable too on a fresh org, but capped out —
    // proves the cap is real, not an accident of there being exactly 3
    // candidates.
    expect(summary.nextActions).toHaveLength(3);
  });

  it("partially completed: completed steps list real accomplishments in order; next actions reflect dependencies unlocked by them", () => {
    const progress = buildOnboardingProgress(signals({ hasClient: true, hasCompanyProfile: true }));
    const summary = getWorkspaceCompletionSummary(progress);

    expect(summary.completedSteps.map((s) => s.key)).toEqual(["COMPANY_PROFILE", "CREATE_CLIENT"]);
    // CREATE_PROJECT and INVITE_PORTAL_USER both depend on CREATE_CLIENT —
    // now actionable and eligible to appear, proving this reflects live
    // dependency state, not a static list.
    expect(summary.nextActions.map((s) => s.key)).toEqual(["PAYMENT_DETAILS", "DOMAIN_SETUP", "CREATE_PROJECT"]);
  });

  it("WELCOME and FINISH never appear in completed steps even when acknowledged — acknowledgments aren't setup accomplishments", () => {
    const progress = buildOnboardingProgress(
      signals({ hasClient: true, actedStepKeys: new Set<OnboardingStepKey>(["WELCOME"]) }),
    );
    const summary = getWorkspaceCompletionSummary(progress);
    expect(summary.completedSteps.map((s) => s.key)).not.toContain("WELCOME");
    expect(summary.completedSteps.map((s) => s.key)).not.toContain("FINISH");
  });

  it("a step that's actionable but has no real destination (WELCOME) is never offered as a next action", () => {
    const progress = buildOnboardingProgress(signals());
    const summary = getWorkspaceCompletionSummary(progress);
    expect(summary.nextActions.map((s) => s.key)).not.toContain("WELCOME");
  });

  it("a skipped step appears in neither list — not a completed accomplishment, not a next action", () => {
    const progress = buildOnboardingProgress(
      signals({ actedStepKeys: new Set<OnboardingStepKey>(["INVITE_TEAMMATE"]) }),
    );
    const summary = getWorkspaceCompletionSummary(progress);
    expect(summary.completedSteps.map((s) => s.key)).not.toContain("INVITE_TEAMMATE");
    expect(summary.nextActions.map((s) => s.key)).not.toContain("INVITE_TEAMMATE");
  });

  it("fully completed setup: every substantive step is a completed accomplishment, no next actions remain", () => {
    const progress = buildOnboardingProgress(
      signals({
        hasClient: true,
        hasProject: true,
        hasTask: true,
        hasSecondMember: true,
        hasPortalUser: true,
        hasCompanyProfile: true,
        hasPaymentDetails: true,
        hasDomainSettings: true,
        actedStepKeys: new Set<OnboardingStepKey>(["REVIEW_BILLING"]),
      }),
    );
    expect(progress.isComplete).toBe(true);

    const summary = getWorkspaceCompletionSummary(progress);
    expect(summary.completedSteps.map((s) => s.key)).toEqual([
      "COMPANY_PROFILE",
      "PAYMENT_DETAILS",
      "DOMAIN_SETUP",
      "CREATE_CLIENT",
      "CREATE_PROJECT",
      "CREATE_TASK",
      "INVITE_TEAMMATE",
      "INVITE_PORTAL_USER",
    ]);
    // REVIEW_BILLING was skipped, not completed — SKIPPED never counts as a
    // completed accomplishment (only status === "COMPLETE" does).
    expect(summary.completedSteps.map((s) => s.key)).not.toContain("REVIEW_BILLING");
    expect(summary.nextActions).toEqual([]);
  });

  it("once every other substantive step is done, REVIEW_BILLING (available since Sale-Ready Phase E, E3.3) becomes the sole remaining next action", () => {
    const progress = buildOnboardingProgress(
      signals({
        hasClient: true,
        hasProject: true,
        hasTask: true,
        hasSecondMember: true,
        hasPortalUser: true,
        hasCompanyProfile: true,
        hasPaymentDetails: true,
        hasDomainSettings: true,
      }),
    );
    // Not complete yet — REVIEW_BILLING is a substantive step still NOT_STARTED.
    expect(progress.isComplete).toBe(false);

    const summary = getWorkspaceCompletionSummary(progress);
    expect(summary.nextActions.map((s) => s.key)).toEqual(["REVIEW_BILLING"]);
    expect(summary.completedSteps.map((s) => s.key)).not.toContain("REVIEW_BILLING");
  });

  it("a skipped REVIEW_BILLING is excluded from completedSteps and is no longer offered as a next action", () => {
    const progress = buildOnboardingProgress(signals({ actedStepKeys: new Set<OnboardingStepKey>(["REVIEW_BILLING"]) }));
    const summary = getWorkspaceCompletionSummary(progress);
    expect(summary.completedSteps.map((s) => s.key)).not.toContain("REVIEW_BILLING");
    expect(summary.nextActions.map((s) => s.key)).not.toContain("REVIEW_BILLING");
  });
});
