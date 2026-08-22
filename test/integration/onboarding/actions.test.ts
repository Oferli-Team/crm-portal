import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  skipOnboardingStepAction,
  acknowledgeOnboardingWelcomeAction,
  finishOnboardingAction,
} from "@/lib/onboarding/actions";
import { getOrganizationOnboardingProgress } from "@/lib/onboarding/progress";
import { createClientAction } from "@/app/(dashboard)/clients/new/actions";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { RedirectSignal } from "../../support/navigation-mock";
import { testSlug } from "../../support/run-id";

/**
 * Onboarding Stage 2 (this stage's own §19/§21/§23). Exercises the real,
 * unmodified skip/acknowledge/finish actions — only Supabase Auth and
 * next/headers' cookies() are mocked (see test/integration/setup-mocks.ts);
 * organization/role resolution via getCurrentUserOrganization() runs for
 * real against the test database.
 */

describe("onboarding actions", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(async () => {
    resetAuthMock();
    await prisma.organizationOnboardingStep.deleteMany({ where: { organizationId: fixtures.orgA.id } });
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  describe("skipOnboardingStepAction", () => {
    it("OWNER can skip a skippable step", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const result = await skipOnboardingStepAction("CREATE_TASK");
      expect(result).toEqual({ ok: true });

      const row = await prisma.organizationOnboardingStep.findUnique({
        where: { organizationId_step: { organizationId: fixtures.orgA.id, step: "CREATE_TASK" } },
      });
      expect(row).not.toBeNull();
    });

    it("a plain MEMBER can also skip — flat access, no role gate (docs/onboarding-architecture.md §13)", async () => {
      actAs(fixtures.member, fixtures.orgA.id);
      const result = await skipOnboardingStepAction("INVITE_TEAMMATE");
      expect(result).toEqual({ ok: true });
    });

    it("an ADMIN can also skip", async () => {
      actAs(fixtures.admin, fixtures.orgA.id);
      const result = await skipOnboardingStepAction("INVITE_PORTAL_USER");
      expect(result).toEqual({ ok: true });
    });

    it("a required, non-skippable step (CREATE_CLIENT) is rejected", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const result = await skipOnboardingStepAction("CREATE_CLIENT");
      expect(result).toEqual({ ok: false, message: "That step can't be skipped." });

      const row = await prisma.organizationOnboardingStep.findUnique({
        where: { organizationId_step: { organizationId: fixtures.orgA.id, step: "CREATE_CLIENT" } },
      });
      expect(row).toBeNull();
    });

    it("CREATE_PROJECT is also rejected (required, not skippable)", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const result = await skipOnboardingStepAction("CREATE_PROJECT");
      expect(result.ok).toBe(false);
    });

    it("an unrecognized step key is rejected", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const result = await skipOnboardingStepAction("NOT_A_REAL_STEP");
      expect(result).toEqual({ ok: false, message: "Unknown onboarding step." });
    });

    it("WELCOME/FINISH are rejected via the skip action (they're never skippable, only acknowledgeable)", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      expect(await skipOnboardingStepAction("WELCOME")).toEqual({ ok: false, message: "That step can't be skipped." });
      expect(await skipOnboardingStepAction("FINISH")).toEqual({ ok: false, message: "That step can't be skipped." });
    });

    it("REVIEW_BILLING can be skipped (Sale-Ready Phase E, E3.3 — available, no Paddle configuration required)", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const result = await skipOnboardingStepAction("REVIEW_BILLING");
      expect(result).toEqual({ ok: true });

      const row = await prisma.organizationOnboardingStep.findUnique({
        where: { organizationId_step: { organizationId: fixtures.orgA.id, step: "REVIEW_BILLING" } },
      });
      expect(row).not.toBeNull();
    });

    it("repeated skip of the same step is idempotent — exactly one row, no error", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      await skipOnboardingStepAction("CREATE_TASK");
      await skipOnboardingStepAction("CREATE_TASK");
      await skipOnboardingStepAction("CREATE_TASK");

      const count = await prisma.organizationOnboardingStep.count({
        where: { organizationId: fixtures.orgA.id, step: "CREATE_TASK" },
      });
      expect(count).toBe(1);
    });

    it("skipping a step that's already Complete by real data is a harmless no-op — computed state still wins", async () => {
      // fixtures.orgA already has a real Task (per seedTestData).
      actAs(fixtures.owner, fixtures.orgA.id);
      const result = await skipOnboardingStepAction("CREATE_TASK");
      expect(result).toEqual({ ok: true });

      const progress = await getOrganizationOnboardingProgress(fixtures.orgA.id);
      expect(progress.steps.find((s) => s.key === "CREATE_TASK")!.status).toBe("COMPLETE");
    });

    it("creates no Activity row", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const before = await prisma.activity.count({ where: { organizationId: fixtures.orgA.id } });
      await skipOnboardingStepAction("CREATE_TASK");
      const after = await prisma.activity.count({ where: { organizationId: fixtures.orgA.id } });
      expect(after).toBe(before);
    });

    it("creates no Notification row", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const before = await prisma.notification.count({ where: { organizationId: fixtures.orgA.id } });
      await skipOnboardingStepAction("INVITE_TEAMMATE");
      const after = await prisma.notification.count({ where: { organizationId: fixtures.orgA.id } });
      expect(after).toBe(before);
    });

    it("cross-org isolation: a tampered active-org cookie naming an org the caller doesn't belong to falls back to the caller's own org, never writes to the named one", async () => {
      // orgBOwner has no Membership in orgA — resolveActiveOrganizationId
      // rejects the tampered cookie and falls back to their real OWNER org
      // (orgB), the same proof pattern already established for Billing's
      // own checkout/portal actions.
      actAs(fixtures.orgBOwner, fixtures.orgA.id);
      const beforeA = await prisma.organizationOnboardingStep.count({ where: { organizationId: fixtures.orgA.id } });

      await skipOnboardingStepAction("CREATE_TASK");

      const afterA = await prisma.organizationOnboardingStep.count({ where: { organizationId: fixtures.orgA.id } });
      expect(afterA).toBe(beforeA);

      // It landed on orgB instead.
      const orgBRow = await prisma.organizationOnboardingStep.findUnique({
        where: { organizationId_step: { organizationId: fixtures.orgB.id, step: "CREATE_TASK" } },
      });
      expect(orgBRow).not.toBeNull();
      await prisma.organizationOnboardingStep.deleteMany({ where: { organizationId: fixtures.orgB.id } });
    });
  });

  describe("acknowledgeOnboardingWelcomeAction / finishOnboardingAction", () => {
    it("acknowledging Welcome writes exactly one WELCOME row, idempotently", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      await acknowledgeOnboardingWelcomeAction();
      await acknowledgeOnboardingWelcomeAction();

      const count = await prisma.organizationOnboardingStep.count({
        where: { organizationId: fixtures.orgA.id, step: "WELCOME" },
      });
      expect(count).toBe(1);
    });

    it("finishing dismisses the checklist (isDismissed true) without requiring every step to be done first", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      // orgA already has Client/Project/Task/teammate/portal complete, but
      // this org fixture never had CREATE_TASK etc. explicitly skipped —
      // finishing must still succeed regardless.
      const result = await finishOnboardingAction();
      expect(result).toEqual({ ok: true });

      const progress = await getOrganizationOnboardingProgress(fixtures.orgA.id);
      expect(progress.isDismissed).toBe(true);
    });

    it("a plain MEMBER can also finish — flat access", async () => {
      actAs(fixtures.member, fixtures.orgA.id);
      const result = await finishOnboardingAction();
      expect(result).toEqual({ ok: true });
    });

    it("creates no Activity or Notification row", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const beforeActivity = await prisma.activity.count({ where: { organizationId: fixtures.orgA.id } });
      const beforeNotification = await prisma.notification.count({ where: { organizationId: fixtures.orgA.id } });

      await acknowledgeOnboardingWelcomeAction();
      await finishOnboardingAction();

      expect(await prisma.activity.count({ where: { organizationId: fixtures.orgA.id } })).toBe(beforeActivity);
      expect(await prisma.notification.count({ where: { organizationId: fixtures.orgA.id } })).toBe(beforeNotification);
    });
  });

  describe("Client Portal identity", () => {
    it("cannot resolve onboarding actions — redirected to /portal, the same staff-only boundary every other staff action already has", async () => {
      actAs({ id: fixtures.portalUser.id, email: fixtures.portalUser.email }, fixtures.orgA.id);
      await expect(skipOnboardingStepAction("CREATE_TASK")).rejects.toThrow("REDIRECT:/portal");
      await expect(finishOnboardingAction()).rejects.toThrow("REDIRECT:/portal");
    });
  });

  describe("§12 invariant: business mutations never write to OrganizationOnboardingStep", () => {
    it("creating a real Client through the real Server Action writes zero onboarding rows — completion is always computed live", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);

      const before = await prisma.organizationOnboardingStep.count({ where: { organizationId: fixtures.orgA.id } });

      const formData = new FormData();
      formData.set("name", `Onboarding Invariant Client ${fixtures.runId}`);

      let caught: unknown;
      try {
        await createClientAction({ error: null }, formData);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RedirectSignal);

      const after = await prisma.organizationOnboardingStep.count({ where: { organizationId: fixtures.orgA.id } });
      expect(after).toBe(before);

      await prisma.client.deleteMany({ where: { name: `Onboarding Invariant Client ${fixtures.runId}` } });
    });
  });

  describe("lifecycle", () => {
    it("deleting an Organization cascades its OrganizationOnboardingStep rows", async () => {
      const org = await prisma.organization.create({
        data: { name: "Cascade Org", slug: testSlug("onboarding-cascade", fixtures.runId) },
      });
      await prisma.organizationOnboardingStep.create({ data: { organizationId: org.id, step: "WELCOME" } });

      await prisma.organization.delete({ where: { id: org.id } });

      const remaining = await prisma.organizationOnboardingStep.count({ where: { organizationId: org.id } });
      expect(remaining).toBe(0);
    });
  });
});
