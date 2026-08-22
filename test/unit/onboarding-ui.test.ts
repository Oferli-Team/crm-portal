import { describe, expect, it } from "vitest";
import { buildOnboardingProgress, type OnboardingRawSignals, type OnboardingStepResult } from "@/lib/onboarding/progress";
import { getOnboardingStepRowActions } from "@/components/onboarding/step-row-actions";
import { shouldRenderOnboardingCard } from "@/components/onboarding/should-render-card";
import type { OnboardingStepKey } from "@/generated/prisma/enums";

/**
 * Onboarding Stage 3 (Stage 3 task §19). Unit-tests the pure UI decision
 * logic extracted out of the components themselves
 * (step-row-actions.ts/should-render-card.ts) — real step results come from
 * the already-tested buildOnboardingProgress (test/unit/onboarding-
 * progress.test.ts) rather than hand-built fixtures, so these tests exercise
 * the real Stage 2 contract shape, not an invented one.
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

function stepOf(progress: ReturnType<typeof buildOnboardingProgress>, key: OnboardingStepKey): OnboardingStepResult {
  return progress.steps.find((s) => s.key === key)!;
}

describe("getOnboardingStepRowActions", () => {
  it("a fresh org: CREATE_CLIENT (NOT_STARTED, no dependency) is actionable with a Go-to link, not skippable", () => {
    const progress = buildOnboardingProgress(signals());
    const actions = getOnboardingStepRowActions(stepOf(progress, "CREATE_CLIENT"));
    expect(actions.isBlocked).toBe(false);
    expect(actions.showGoTo).toBe(true);
    expect(actions.showSkip).toBe(false);
  });

  it("a fresh org: CREATE_PROJECT is blocked behind CREATE_CLIENT — no Go-to, no Skip, description is the exact empty-state copy", () => {
    const progress = buildOnboardingProgress(signals());
    const actions = getOnboardingStepRowActions(stepOf(progress, "CREATE_PROJECT"));
    expect(actions.isBlocked).toBe(true);
    expect(actions.showGoTo).toBe(false);
    expect(actions.showSkip).toBe(false);
    expect(actions.description).toBe("Projects must belong to a client. Add one before creating a project.");
  });

  it("a fresh org: CREATE_TASK is blocked behind CREATE_PROJECT, but skip is still offered (skip has no dependency check)", () => {
    const progress = buildOnboardingProgress(signals());
    const actions = getOnboardingStepRowActions(stepOf(progress, "CREATE_TASK"));
    expect(actions.isBlocked).toBe(true);
    expect(actions.showGoTo).toBe(false);
    expect(actions.showSkip).toBe(true);
    expect(actions.description).toBe("Tasks must belong to a project. Add one before creating a task.");
  });

  it("an unblocked, skippable step (INVITE_TEAMMATE) shows both Go-to and Skip", () => {
    const progress = buildOnboardingProgress(signals());
    const actions = getOnboardingStepRowActions(stepOf(progress, "INVITE_TEAMMATE"));
    expect(actions.isBlocked).toBe(false);
    expect(actions.showGoTo).toBe(true);
    expect(actions.showSkip).toBe(true);
  });

  it("a COMPLETE step (real data) shows no action at all", () => {
    const progress = buildOnboardingProgress(signals({ hasClient: true }));
    const actions = getOnboardingStepRowActions(stepOf(progress, "CREATE_CLIENT"));
    expect(actions.showGoTo).toBe(false);
    expect(actions.showSkip).toBe(false);
  });

  it("a SKIPPED step shows no action at all — un-skip only ever happens by doing the real thing", () => {
    const progress = buildOnboardingProgress(
      signals({ actedStepKeys: new Set<OnboardingStepKey>(["INVITE_TEAMMATE"]) }),
    );
    const step = stepOf(progress, "INVITE_TEAMMATE");
    expect(step.status).toBe("SKIPPED");
    const actions = getOnboardingStepRowActions(step);
    expect(actions.showGoTo).toBe(false);
    expect(actions.showSkip).toBe(false);
  });

  it("REVIEW_BILLING (Sale-Ready Phase E, E3.3 — available, unblocked, skippable) shows both Go-to and Skip, same shape as INVITE_TEAMMATE", () => {
    const progress = buildOnboardingProgress(signals());
    const step = stepOf(progress, "REVIEW_BILLING");
    expect(step.status).toBe("NOT_STARTED");
    const actions = getOnboardingStepRowActions(step);
    expect(actions.isBlocked).toBe(false);
    expect(actions.showGoTo).toBe(true);
    expect(actions.showSkip).toBe(true);
  });

  it("a SKIPPED REVIEW_BILLING shows no action at all, same as any other skipped step", () => {
    const progress = buildOnboardingProgress(
      signals({ actedStepKeys: new Set<OnboardingStepKey>(["REVIEW_BILLING"]) }),
    );
    const step = stepOf(progress, "REVIEW_BILLING");
    expect(step.status).toBe("SKIPPED");
    const actions = getOnboardingStepRowActions(step);
    expect(actions.showGoTo).toBe(false);
    expect(actions.showSkip).toBe(false);
  });

  it("WELCOME and FINISH naturally get no action button (null targetHref, not skippable) with no special-casing", () => {
    const progress = buildOnboardingProgress(signals());
    for (const key of ["WELCOME", "FINISH"] as const) {
      const actions = getOnboardingStepRowActions(stepOf(progress, key));
      expect(actions.showGoTo).toBe(false);
      expect(actions.showSkip).toBe(false);
    }
  });

  describe("iconWrapperClassName (Stage 6 audit fix — dimming scoped to the icon only)", () => {
    it("a blocked step (CREATE_PROJECT, dependency not yet met) dims only the icon wrapper", () => {
      const progress = buildOnboardingProgress(signals());
      const actions = getOnboardingStepRowActions(stepOf(progress, "CREATE_PROJECT"));
      expect(actions.isBlocked).toBe(true);
      expect(actions.iconWrapperClassName).toContain("opacity-60");
    });

    it("an unblocked, actionable step applies no opacity to the icon wrapper", () => {
      const progress = buildOnboardingProgress(signals());
      const actions = getOnboardingStepRowActions(stepOf(progress, "CREATE_CLIENT"));
      expect(actions.isBlocked).toBe(false);
      expect(actions.iconWrapperClassName).not.toContain("opacity");
    });

    it("a COMPLETE step applies no opacity to the icon wrapper", () => {
      const progress = buildOnboardingProgress(signals({ hasClient: true }));
      const actions = getOnboardingStepRowActions(stepOf(progress, "CREATE_CLIENT"));
      expect(actions.iconWrapperClassName).not.toContain("opacity");
    });

    it("the returned className never targets description/label text — only ever describes the icon wrapper's own class string", () => {
      // A structural guard against the exact Stage 6 regression: the old
      // implementation applied opacity-60 to a wrapper that ALSO contained
      // the label/description, dropping the description's own text-gray-500
      // to ~2.3:1 contrast (below WCAG AA's 4.5:1). This field is the only
      // place dimming is decided — proving it stays a single, narrowly-typed
      // string (never an object with separate description/label keys) is a
      // cheap guard against someone widening its scope again later.
      const progress = buildOnboardingProgress(signals());
      const actions = getOnboardingStepRowActions(stepOf(progress, "CREATE_PROJECT"));
      expect(typeof actions.iconWrapperClassName).toBe("string");
      expect(Object.keys(actions)).toEqual(["isBlocked", "showGoTo", "showSkip", "description", "iconWrapperClassName"]);
    });
  });
});

describe("shouldRenderOnboardingCard", () => {
  it("a fresh, empty organization renders the card", () => {
    const progress = buildOnboardingProgress(signals());
    expect(shouldRenderOnboardingCard(progress)).toBe(true);
  });

  it("a partially-progressed organization still renders the card", () => {
    const progress = buildOnboardingProgress(signals({ hasClient: true, hasProject: true }));
    expect(progress.isComplete).toBe(false);
    expect(shouldRenderOnboardingCard(progress)).toBe(true);
  });

  it("a fully complete organization (every substantive step done) hides the card", () => {
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
    expect(shouldRenderOnboardingCard(progress)).toBe(false);
  });

  it("a dismissed organization (FINISH acknowledged) hides the card even with nothing else done", () => {
    const progress = buildOnboardingProgress(signals({ actedStepKeys: new Set<OnboardingStepKey>(["FINISH"]) }));
    expect(progress.isDismissed).toBe(true);
    expect(progress.isComplete).toBe(false);
    expect(shouldRenderOnboardingCard(progress)).toBe(false);
  });
});
