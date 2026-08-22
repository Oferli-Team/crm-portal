import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  skipOnboardingStepAction,
  acknowledgeOnboardingWelcomeAction,
  finishOnboardingAction,
} from "@/lib/onboarding/actions";
import { getOrganizationOnboardingProgress } from "@/lib/onboarding/progress";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { getNavigationCalls, resetNavigationMock } from "../../support/navigation-mock";

/**
 * Onboarding Stage 3 (Stage 3 task §10/§18). Proves the exact wiring the
 * Dashboard card depends on to update "without a manual page reload": each
 * Stage 2 action calls next/cache's revalidatePath("/dashboard") — asserted
 * against the same recorded-call mock every redirect()/notFound() assertion
 * elsewhere in this suite already uses (test/support/navigation-mock.ts),
 * not a new mechanism. Everything else about these three actions (their
 * own row-write behavior, access rules, idempotency) is already covered by
 * test/integration/onboarding/actions.test.ts (Stage 2) and stays
 * unmodified here.
 */

describe("onboarding actions revalidate /dashboard for the Stage 3 UI", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(async () => {
    resetAuthMock();
    resetNavigationMock();
    await prisma.organizationOnboardingStep.deleteMany({ where: { organizationId: fixtures.orgA.id } });
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("skipOnboardingStepAction revalidates /dashboard on a successful skip", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await skipOnboardingStepAction("CREATE_TASK");
    expect(result).toEqual({ ok: true });
    expect(getNavigationCalls()).toContainEqual({ type: "revalidatePath", path: "/dashboard" });
  });

  it("skipOnboardingStepAction does NOT revalidate when the step is rejected (no write happened)", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await skipOnboardingStepAction("CREATE_CLIENT");
    expect(result.ok).toBe(false);
    expect(getNavigationCalls()).toEqual([]);
  });

  it("acknowledgeOnboardingWelcomeAction revalidates /dashboard", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    await acknowledgeOnboardingWelcomeAction();
    expect(getNavigationCalls()).toContainEqual({ type: "revalidatePath", path: "/dashboard" });
  });

  it("finishOnboardingAction revalidates /dashboard, and the next progress read reflects isDismissed immediately (no separate cache to warm)", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    await finishOnboardingAction();
    expect(getNavigationCalls()).toContainEqual({ type: "revalidatePath", path: "/dashboard" });

    const progress = await getOrganizationOnboardingProgress(fixtures.orgA.id);
    expect(progress.isDismissed).toBe(true);
  });
});
