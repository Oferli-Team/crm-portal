import { describe, expect, it } from "vitest";
import { buildOnboardingProgress, type OnboardingRawSignals } from "@/lib/onboarding/progress";
import type { OnboardingStepKey } from "@/generated/prisma/enums";

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

function statusOf(progress: ReturnType<typeof buildOnboardingProgress>, key: OnboardingStepKey) {
  return progress.steps.find((s) => s.key === key)!.status;
}

describe("buildOnboardingProgress — a fresh, fully empty organization", () => {
  const progress = buildOnboardingProgress(signals());

  it("every substantive step is NOT_STARTED", () => {
    expect(statusOf(progress, "CREATE_CLIENT")).toBe("NOT_STARTED");
    expect(statusOf(progress, "CREATE_PROJECT")).toBe("NOT_STARTED");
    expect(statusOf(progress, "CREATE_TASK")).toBe("NOT_STARTED");
    expect(statusOf(progress, "INVITE_TEAMMATE")).toBe("NOT_STARTED");
    expect(statusOf(progress, "INVITE_PORTAL_USER")).toBe("NOT_STARTED");
    expect(statusOf(progress, "REVIEW_BILLING")).toBe("NOT_STARTED");
  });

  it("REVIEW_BILLING is available (Sale-Ready Phase E, E3.3) — NOT_STARTED, actionable, with a real targetHref, no Paddle configuration required", () => {
    const step = progress.steps.find((s) => s.key === "REVIEW_BILLING")!;
    expect(step.status).toBe("NOT_STARTED");
    expect(step.actionable).toBe(true);
    expect(step.blockedReason).toBeNull();
    expect(step.targetHref).toBe("/settings/billing");
    expect(step.skippable).toBe(true);
  });

  it("CREATE_CLIENT is actionable (no dependency); CREATE_PROJECT/CREATE_TASK are blocked", () => {
    const client = progress.steps.find((s) => s.key === "CREATE_CLIENT")!;
    const project = progress.steps.find((s) => s.key === "CREATE_PROJECT")!;
    const task = progress.steps.find((s) => s.key === "CREATE_TASK")!;

    expect(client.actionable).toBe(true);
    expect(client.blockedReason).toBeNull();

    expect(project.actionable).toBe(false);
    expect(project.blockedReason).toBe("Projects must belong to a client. Add one before creating a project.");

    expect(task.actionable).toBe(false);
    expect(task.blockedReason).toBe("Tasks must belong to a project. Add one before creating a task.");
  });

  it("INVITE_PORTAL_USER is blocked on CREATE_CLIENT too", () => {
    const portal = progress.steps.find((s) => s.key === "INVITE_PORTAL_USER")!;
    expect(portal.actionable).toBe(false);
    expect(portal.blockedReason).toBe("Invite a Client Portal user once you have at least one client.");
  });

  it("INVITE_TEAMMATE has no dependency — always actionable", () => {
    const teammate = progress.steps.find((s) => s.key === "INVITE_TEAMMATE")!;
    expect(teammate.actionable).toBe(true);
    expect(teammate.blockedReason).toBeNull();
  });

  it("percent is 0", () => {
    expect(progress.percent).toBe(0);
    expect(progress.completedCount).toBe(0);
  });

  it("is not complete, not dismissed", () => {
    expect(progress.isComplete).toBe(false);
    expect(progress.isDismissed).toBe(false);
  });

  it("requiredCompleted is 0 of 3 (Company Profile, Client, Project — Stage 6.2 adds Company Profile as required)", () => {
    expect(progress.requiredTotal).toBe(3);
    expect(progress.requiredCompleted).toBe(0);
  });
});

describe("buildOnboardingProgress — incremental real data", () => {
  it("Client only: CREATE_CLIENT complete, CREATE_PROJECT now actionable (not blocked)", () => {
    const progress = buildOnboardingProgress(signals({ hasClient: true }));
    expect(statusOf(progress, "CREATE_CLIENT")).toBe("COMPLETE");
    const project = progress.steps.find((s) => s.key === "CREATE_PROJECT")!;
    expect(project.status).toBe("NOT_STARTED");
    expect(project.actionable).toBe(true);
    expect(project.blockedReason).toBeNull();

    const portal = progress.steps.find((s) => s.key === "INVITE_PORTAL_USER")!;
    expect(portal.actionable).toBe(true);

    expect(progress.requiredCompleted).toBe(1);
  });

  it("Client + Project: CREATE_TASK now actionable", () => {
    const progress = buildOnboardingProgress(signals({ hasClient: true, hasProject: true }));
    expect(statusOf(progress, "CREATE_PROJECT")).toBe("COMPLETE");
    const task = progress.steps.find((s) => s.key === "CREATE_TASK")!;
    expect(task.actionable).toBe(true);
    expect(progress.requiredCompleted).toBe(2);
  });

  it("Client + Project + Task: all three computed steps complete", () => {
    const progress = buildOnboardingProgress(signals({ hasClient: true, hasProject: true, hasTask: true }));
    expect(statusOf(progress, "CREATE_CLIENT")).toBe("COMPLETE");
    expect(statusOf(progress, "CREATE_PROJECT")).toBe("COMPLETE");
    expect(statusOf(progress, "CREATE_TASK")).toBe("COMPLETE");
  });
});

describe("buildOnboardingProgress — teammate semantics", () => {
  it("a lone OWNER (membership count 1) never satisfies INVITE_TEAMMATE", () => {
    // hasSecondMember is already the caller's own membership.count > 1
    // check — false here models exactly that case.
    const progress = buildOnboardingProgress(signals({ hasSecondMember: false }));
    expect(statusOf(progress, "INVITE_TEAMMATE")).toBe("NOT_STARTED");
  });

  it("a real accepted second Membership satisfies it", () => {
    const progress = buildOnboardingProgress(signals({ hasSecondMember: true }));
    expect(statusOf(progress, "INVITE_TEAMMATE")).toBe("COMPLETE");
  });

  it("a pending invitation alone (no accepted Membership) must never satisfy it — a caller that (incorrectly) folds a pending invite into hasSecondMember is not this function's concern, but this test documents the contract: only an accepted Membership counts", () => {
    // This is exactly the invariant docs/onboarding-architecture.md §4
    // requires: hasSecondMember must be sourced from membership.count > 1,
    // never invitation.count. The pure function only ever sees the
    // already-resolved boolean, so this test asserts the *false* case
    // stays NOT_STARTED even when a caller might otherwise be tempted to
    // pass "has a pending invite" in by mistake.
    const progress = buildOnboardingProgress(signals({ hasSecondMember: false }));
    expect(statusOf(progress, "INVITE_TEAMMATE")).not.toBe("COMPLETE");
  });
});

describe("buildOnboardingProgress — portal semantics", () => {
  it("a Client alone does not satisfy INVITE_PORTAL_USER", () => {
    const progress = buildOnboardingProgress(signals({ hasClient: true, hasPortalUser: false }));
    expect(statusOf(progress, "INVITE_PORTAL_USER")).toBe("NOT_STARTED");
  });

  it("a real PortalUser (accepted) satisfies it", () => {
    const progress = buildOnboardingProgress(signals({ hasClient: true, hasPortalUser: true }));
    expect(statusOf(progress, "INVITE_PORTAL_USER")).toBe("COMPLETE");
  });
});

describe("buildOnboardingProgress — skip semantics", () => {
  it("a skippable step with an acted row and no real data is SKIPPED, not NOT_STARTED", () => {
    const progress = buildOnboardingProgress(
      signals({ hasClient: true, hasProject: true, actedStepKeys: new Set(["CREATE_TASK"]) }),
    );
    expect(statusOf(progress, "CREATE_TASK")).toBe("SKIPPED");
  });

  it("real data completing a step always beats a stale skip row for the same step (§7's own 'un-skip by doing' rule)", () => {
    const progress = buildOnboardingProgress(
      signals({
        hasClient: true,
        hasProject: true,
        hasTask: true,
        actedStepKeys: new Set(["CREATE_TASK"]),
      }),
    );
    expect(statusOf(progress, "CREATE_TASK")).toBe("COMPLETE");
  });

  it("skipped counts toward the percent numerator, same as complete", () => {
    const empty = buildOnboardingProgress(signals());
    const skipped = buildOnboardingProgress(signals({ actedStepKeys: new Set(["CREATE_TASK"]) }));
    expect(skipped.completedCount).toBe(empty.completedCount + 1);
  });

  it("an acted row for WELCOME/FINISH marks it COMPLETE via acknowledgment, not skip", () => {
    const progress = buildOnboardingProgress(signals({ actedStepKeys: new Set(["WELCOME", "FINISH"]) }));
    const welcome = progress.steps.find((s) => s.key === "WELCOME")!;
    const finish = progress.steps.find((s) => s.key === "FINISH")!;
    expect(welcome.status).toBe("COMPLETE");
    expect(welcome.completionSource).toBe("acknowledged");
    expect(finish.status).toBe("COMPLETE");
    expect(finish.completionSource).toBe("acknowledged");
  });
});

describe("buildOnboardingProgress — percent semantics and boundaries", () => {
  it("percent denominator is 10 (excludes WELCOME; includes FINISH; includes the Customer Setup Wizard's three steps — Stage 6.2 — and REVIEW_BILLING, available since Sale-Ready Phase E, E3.3)", () => {
    const progress = buildOnboardingProgress(signals());
    expect(progress.totalCount).toBe(10);
  });

  it("5 of 10 substantive-plus-finish steps done is 50%", () => {
    const progress = buildOnboardingProgress(
      signals({
        hasClient: true,
        hasProject: true,
        hasTask: true,
        hasSecondMember: true,
        hasPortalUser: true,
        // COMPANY_PROFILE/PAYMENT_DETAILS/DOMAIN_SETUP, REVIEW_BILLING, and FINISH not yet done/acknowledged.
      }),
    );
    expect(progress.completedCount).toBe(5);
    expect(progress.totalCount).toBe(10);
    expect(progress.percent).toBe(50);
  });

  it("every substantive step done AND Finish acknowledged is 100%", () => {
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
        actedStepKeys: new Set(["REVIEW_BILLING", "FINISH"]),
      }),
    );
    expect(progress.percent).toBe(100);
    expect(progress.completedCount).toBe(progress.totalCount);
  });

  it("isComplete (§3 path 1) is true once every substantive step is done/skipped, independent of Finish ever being clicked", () => {
    const progress = buildOnboardingProgress(
      signals({
        hasClient: true,
        hasProject: true,
        hasCompanyProfile: true,
        actedStepKeys: new Set([
          "PAYMENT_DETAILS",
          "DOMAIN_SETUP",
          "CREATE_TASK",
          "INVITE_TEAMMATE",
          "INVITE_PORTAL_USER",
          "REVIEW_BILLING",
        ]),
      }),
    );
    expect(progress.isComplete).toBe(true);
    expect(progress.isDismissed).toBe(false);
    // percent is NOT 100 — Finish itself is still an outstanding, counted step.
    expect(progress.percent).toBeLessThan(100);
  });

  it("a skipped REVIEW_BILLING resolves to SKIPPED, not COMPLETE — clicking Skip must not show the same green checkmark as actually reviewing the page", () => {
    const progress = buildOnboardingProgress(signals({ actedStepKeys: new Set(["REVIEW_BILLING"]) }));
    const step = progress.steps.find((s) => s.key === "REVIEW_BILLING")!;
    expect(step.status).toBe("SKIPPED");
    expect(step.completionSource).toBe("skipped");
    expect(step.actionable).toBe(false);
  });

  it("dismissed-but-incomplete: isDismissed true, isComplete false, percent reflects real partial progress (never jumps to 100)", () => {
    const progress = buildOnboardingProgress(
      signals({ hasClient: true, actedStepKeys: new Set(["FINISH"]) }),
    );
    expect(progress.isDismissed).toBe(true);
    expect(progress.isComplete).toBe(false);
    expect(progress.percent).toBeGreaterThan(0);
    expect(progress.percent).toBeLessThan(100);
  });
});

describe("buildOnboardingProgress — a new teammate joining an already-productive org", () => {
  it("sees the org's real progress immediately, not a reset — the org-scoped model's own central guarantee", () => {
    // Modeling "org already has Client/Project/a second Membership" —
    // exactly what a freshly-invited third member would see on their own
    // very first read, since progress is a property of the organization's
    // data, never of which member is asking.
    const progress = buildOnboardingProgress(
      signals({ hasClient: true, hasProject: true, hasTask: true, hasSecondMember: true }),
    );
    expect(statusOf(progress, "CREATE_CLIENT")).toBe("COMPLETE");
    expect(statusOf(progress, "CREATE_PROJECT")).toBe("COMPLETE");
    expect(statusOf(progress, "CREATE_TASK")).toBe("COMPLETE");
    expect(statusOf(progress, "INVITE_TEAMMATE")).toBe("COMPLETE");
  });
});
