import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Forces getBillingProviderAdapter() to resolve to the real
// MockBillingProvider — see test/integration/billing/webhook.test.ts's own
// header comment for why this file needs it (checkout/portal now redirect
// to a real mock session URL once a provider is configured, unlike Stage
// 3's own actions.test.ts, which deliberately covers the *unconfigured*
// default and needs no such mock).
vi.mock("server-only", () => ({}));
vi.mock("@/lib/test-mode", () => ({ TEST_MODE: true }));

import { prisma } from "@/lib/prisma";
import { requestPlanChangeAction, manageSubscriptionAction } from "@/app/(dashboard)/settings/billing/actions";
import { deriveMockCustomerId } from "@/lib/billing/provider/mock-provider";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { RedirectSignal, resetNavigationMock } from "../../support/navigation-mock";

describe("checkout/portal actions with a configured (mock) provider", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(async () => {
    resetAuthMock();
    resetNavigationMock();
    await prisma.subscription.deleteMany({ where: { organizationId: fixtures.orgA.id } });
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  describe("requestPlanChangeAction", () => {
    it("OWNER is redirected to a mock checkout URL, with no Subscription row written yet", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);

      let caught: unknown;
      try {
        await requestPlanChangeAction("PRO");
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RedirectSignal);
      const url = (caught as RedirectSignal).url;
      expect(url).toContain("/billing/mock/checkout");
      expect(url).toContain(`organizationId=${fixtures.orgA.id}`);
      expect(url).toContain("planKey=PRO");

      const subscription = await prisma.subscription.findUnique({ where: { organizationId: fixtures.orgA.id } });
      expect(subscription).toBeNull();
    });

    it("reuses an existing providerCustomerId in the checkout URL instead of a fresh one", async () => {
      const existingCustomerId = "cus_existing_from_prior_checkout";
      await prisma.subscription.create({
        data: {
          organizationId: fixtures.orgA.id,
          planKey: "TRIAL",
          status: "TRIALING",
          providerCustomerId: existingCustomerId,
          trialStartedAt: new Date(),
          trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        },
      });
      actAs(fixtures.owner, fixtures.orgA.id);

      let caught: unknown;
      try {
        await requestPlanChangeAction("PRO");
      } catch (err) {
        caught = err;
      }

      expect((caught as RedirectSignal).url).toContain(`customerId=${existingCustomerId}`);
    });

    it("ADMIN is blocked before ever resolving a provider session", async () => {
      actAs(fixtures.admin, fixtures.orgA.id);
      const result = await requestPlanChangeAction("PRO");
      expect(result).toEqual({ ok: false, message: "Only the organization owner can manage billing." });
    });

    it("an invalid plan key is rejected even for the OWNER, before any provider call", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const result = await requestPlanChangeAction("NOT_A_REAL_PLAN");
      expect(result).toEqual({ ok: false, message: "That plan isn't available." });
    });
  });

  describe("manageSubscriptionAction", () => {
    it("OWNER with no billing account yet (no providerCustomerId) gets a controlled message, not a crash", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const result = await manageSubscriptionAction();
      expect(result).toEqual({ ok: false, message: "There's no billing account to manage yet — upgrade to a paid plan first." });
    });

    it("OWNER with an existing providerCustomerId is redirected to the mock portal", async () => {
      await prisma.subscription.create({
        data: {
          organizationId: fixtures.orgA.id,
          planKey: "STARTER",
          status: "ACTIVE",
          providerCustomerId: deriveMockCustomerId(fixtures.orgA.id),
          trialStartedAt: new Date(),
          trialEndsAt: new Date(),
        },
      });
      actAs(fixtures.owner, fixtures.orgA.id);

      let caught: unknown;
      try {
        await manageSubscriptionAction();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RedirectSignal);
      expect((caught as RedirectSignal).url).toContain("/billing/mock/portal");
    });

    it("MEMBER is blocked", async () => {
      actAs(fixtures.member, fixtures.orgA.id);
      const result = await manageSubscriptionAction();
      expect(result).toEqual({ ok: false, message: "Only the organization owner can manage billing." });
    });
  });

  describe("Client Portal identity", () => {
    it("cannot resolve checkout/portal actions — redirected to /portal, the same staff-only boundary as every other billing action", async () => {
      actAs({ id: fixtures.portalUser.id, email: fixtures.portalUser.email }, fixtures.orgA.id);
      await expect(requestPlanChangeAction("PRO")).rejects.toThrow("REDIRECT:/portal");
      await expect(manageSubscriptionAction()).rejects.toThrow("REDIRECT:/portal");
    });
  });
});
