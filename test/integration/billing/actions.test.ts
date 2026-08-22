import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// src/app/(dashboard)/settings/billing/actions.ts imports src/lib/billing/
// provider/provider.ts, which imports the real "server-only" marker
// package — see test/unit/cron-auth.test.ts's own header comment.
vi.mock("server-only", () => ({}));

import { prisma } from "@/lib/prisma";
import { requestPlanChangeAction, manageSubscriptionAction } from "@/app/(dashboard)/settings/billing/actions";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";

/**
 * Billing & Subscriptions Stage 3 (this stage's own §17). Exercises the
 * REAL, unmodified requestPlanChangeAction/manageSubscriptionAction — only
 * Supabase Auth and next/headers' cookies() are mocked (see
 * test/integration/setup-mocks.ts); role resolution via getCurrentMembership()
 * runs for real against the test database.
 */

describe("billing placeholder actions", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
    await prisma.subscription.create({
      data: {
        organizationId: fixtures.orgA.id,
        planKey: "STARTER",
        status: "ACTIVE",
        trialStartedAt: new Date(),
        trialEndsAt: new Date(),
      },
    });
  });

  afterEach(() => {
    resetAuthMock();
  });

  afterAll(async () => {
    await prisma.subscription.deleteMany({ where: { organizationId: fixtures.orgA.id } });
    await cleanupTestData(fixtures);
  });

  async function snapshotBillingState() {
    const [subscriptionCount, webhookEventCount, activityCount] = await Promise.all([
      prisma.subscription.count(),
      prisma.webhookEvent.count(),
      prisma.activity.count({ where: { organizationId: fixtures.orgA.id } }),
    ]);
    return { subscriptionCount, webhookEventCount, activityCount };
  }

  describe("requestPlanChangeAction", () => {
    it("OWNER gets a controlled 'not configured' result — never a thrown error", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const before = await snapshotBillingState();

      const result = await requestPlanChangeAction("PRO");

      expect(result).toEqual({ ok: false, message: "Billing provider is not configured." });
      expect(await snapshotBillingState()).toEqual(before);
    });

    it("ADMIN is blocked with a permission message, not the provider-unconfigured one", async () => {
      actAs(fixtures.admin, fixtures.orgA.id);
      const result = await requestPlanChangeAction("PRO");
      expect(result).toEqual({ ok: false, message: "Only the organization owner can manage billing." });
    });

    it("MEMBER is blocked with a permission message", async () => {
      actAs(fixtures.member, fixtures.orgA.id);
      const result = await requestPlanChangeAction("PRO");
      expect(result).toEqual({ ok: false, message: "Only the organization owner can manage billing." });
    });

    it("an invalid/unpurchasable plan key is rejected even for the OWNER, and the Subscription row is untouched", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const before = await prisma.subscription.findUnique({ where: { organizationId: fixtures.orgA.id } });

      const invalidResult = await requestPlanChangeAction("NOT_A_REAL_PLAN");
      const legacyResult = await requestPlanChangeAction("LEGACY");
      const trialResult = await requestPlanChangeAction("TRIAL");

      expect(invalidResult).toEqual({ ok: false, message: "That plan isn't available." });
      expect(legacyResult).toEqual({ ok: false, message: "That plan isn't available." });
      expect(trialResult).toEqual({ ok: false, message: "That plan isn't available." });

      const after = await prisma.subscription.findUnique({ where: { organizationId: fixtures.orgA.id } });
      expect(after).toEqual(before);
    });

    it("cross-org manipulation is impossible — a tampered active-org cookie naming an org the caller doesn't belong to is ignored, falling back to the caller's own org", async () => {
      // orgBOwner has no Membership in orgA at all; resolveActiveOrganizationId
      // (src/lib/current-user.ts) rejects the tampered cookie and falls back to
      // their real OWNER org (orgB) — org A's own Subscription row is provably
      // never touched by this call.
      actAs(fixtures.orgBOwner, fixtures.orgA.id);
      const beforeA = await prisma.subscription.findUnique({ where: { organizationId: fixtures.orgA.id } });

      const result = await requestPlanChangeAction("PRO");

      expect(result).toEqual({ ok: false, message: "Billing provider is not configured." });
      const afterA = await prisma.subscription.findUnique({ where: { organizationId: fixtures.orgA.id } });
      expect(afterA).toEqual(beforeA);
    });

    it("creates no Activity row", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const beforeCount = await prisma.activity.count({ where: { organizationId: fixtures.orgA.id } });
      await requestPlanChangeAction("PRO");
      const afterCount = await prisma.activity.count({ where: { organizationId: fixtures.orgA.id } });
      expect(afterCount).toBe(beforeCount);
    });
  });

  describe("manageSubscriptionAction", () => {
    it("OWNER gets a controlled 'not configured' result", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const before = await snapshotBillingState();

      const result = await manageSubscriptionAction();

      expect(result).toEqual({ ok: false, message: "Billing provider is not configured." });
      expect(await snapshotBillingState()).toEqual(before);
    });

    it("ADMIN is blocked", async () => {
      actAs(fixtures.admin, fixtures.orgA.id);
      const result = await manageSubscriptionAction();
      expect(result).toEqual({ ok: false, message: "Only the organization owner can manage billing." });
    });

    it("MEMBER is blocked", async () => {
      actAs(fixtures.member, fixtures.orgA.id);
      const result = await manageSubscriptionAction();
      expect(result).toEqual({ ok: false, message: "Only the organization owner can manage billing." });
    });

    it("acting as a different org's real OWNER only ever affects that org — org A's Subscription row is untouched", async () => {
      actAs(fixtures.orgBOwner, fixtures.orgB.id);
      const beforeA = await prisma.subscription.findUnique({ where: { organizationId: fixtures.orgA.id } });

      await manageSubscriptionAction();

      const afterA = await prisma.subscription.findUnique({ where: { organizationId: fixtures.orgA.id } });
      expect(afterA).toEqual(beforeA);
    });
  });

  describe("Client Portal identity", () => {
    it("cannot resolve billing actions — the same staff-only boundary every dashboard action already relies on redirects them to /portal", async () => {
      actAs({ id: fixtures.portalUser.id, email: fixtures.portalUser.email }, fixtures.orgA.id);
      await expect(requestPlanChangeAction("PRO")).rejects.toThrow("REDIRECT:/portal");
      await expect(manageSubscriptionAction()).rejects.toThrow("REDIRECT:/portal");
    });
  });
});
