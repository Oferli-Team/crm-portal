import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { updateCompanyProfileAction } from "@/app/(dashboard)/settings/company/actions";
import { updatePaymentDetailsAction } from "@/app/(dashboard)/settings/payment/actions";
import { updateDomainSettingsAction } from "@/app/(dashboard)/settings/domain/actions";
import { createClientAction } from "@/app/(dashboard)/clients/new/actions";
import { getCurrentMembership, getCurrentUserOrganization } from "@/lib/current-user";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { RedirectSignal } from "../../support/navigation-mock";

/**
 * Stage 6.2.1 — Session Redirect / Server Action UX Stabilization.
 *
 * Root cause (found by audit, not live reproduction — see the stage's own
 * final report for the full reasoning): a single dashboard request
 * routinely resolves "who is the current user?" several times over (the
 * root layout, getOrCreateUser() — itself already documented as "called
 * independently from ~20 pages/actions with no shared request-level
 * cache" — the page being rendered, and any Server Action it invokes),
 * each making its own independent createClient() + auth.getUser() call.
 * Fixed by src/lib/supabase/server.ts's new getVerifiedAuthUser(), a
 * React.cache()-memoized wrapper getOrCreateUser() and (dashboard)/
 * layout.tsx now both call, so the real auth check happens once per
 * request instead of being redundantly repeated.
 *
 * This memoization only actually takes effect inside a real Next.js
 * request-scoped render — verified empirically (see the stage's own
 * report) that React.cache() does not dedupe calls in this bare Vitest
 * environment, which has no such render boundary. What these tests
 * *can* prove, and do: the refactor introduces no functional
 * regression, and — directly matching the reported symptom — the
 * current identity remains correctly resolvable as authenticated
 * immediately after each of these Server Actions succeeds (exactly the
 * check a follow-up page render performs), for both new (company/
 * payment/domain) and pre-existing, unrelated (createClientAction)
 * actions alike.
 */

function companyForm(): FormData {
  const fd = new FormData();
  fd.set("legalName", "Stability Test LLC");
  fd.set("displayName", "Stability Co");
  fd.set("country", "United States");
  fd.set("currency", "USD");
  fd.set("timezone", "America/New_York");
  return fd;
}

function paymentForm(): FormData {
  const fd = new FormData();
  fd.set("bankName", "Stability Bank");
  fd.set("accountHolder", "Stability Co");
  fd.set("accountNumber", "GB29NWBK60161331926819");
  fd.set("swiftBic", "NWBKGB2L");
  return fd;
}

function domainForm(): FormData {
  const fd = new FormData();
  fd.set("customDomain", "");
  return fd;
}

describe("Session stability after a successful Server Action — Stage 6.2.1", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(async () => {
    resetAuthMock();
    await prisma.organizationProfile.deleteMany({ where: { organizationId: fixtures.orgA.id } });
    await prisma.organizationPaymentDetails.deleteMany({ where: { organizationId: fixtures.orgA.id } });
    await prisma.organizationDomainSettings.deleteMany({ where: { organizationId: fixtures.orgA.id } });
    await prisma.client.deleteMany({ where: { organizationId: fixtures.orgA.id, id: { not: fixtures.clientA.id } } });
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  describe("Company Profile — OWNER", () => {
    it("saves company data, the mutation succeeds, and the user remains authenticated afterward", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);

      const result = await updateCompanyProfileAction({ error: null }, companyForm());
      expect(result.error).toBeNull();
      expect(result.message).toBe("Company profile saved.");

      const profile = await prisma.organizationProfile.findUnique({ where: { organizationId: fixtures.orgA.id } });
      expect(profile?.legalName).toBe("Stability Test LLC");

      // The exact check a follow-up page render performs — must still
      // resolve the same identity, not redirect.
      const { user, organizationId, membership } = await getCurrentMembership();
      expect(user.id).toBe(fixtures.owner.id);
      expect(organizationId).toBe(fixtures.orgA.id);
      expect(membership.role).toBe("OWNER");
    });
  });

  describe("Payment Details — OWNER", () => {
    it("saves payment data and stays authenticated, no redirect to login", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);

      const result = await updatePaymentDetailsAction({ error: null }, paymentForm());
      expect(result.error).toBeNull();
      expect(result.message).toBe("Payment details saved.");

      const row = await prisma.organizationPaymentDetails.findUnique({ where: { organizationId: fixtures.orgA.id } });
      expect(row?.bankName).toBe("Stability Bank");

      await expect(getCurrentMembership()).resolves.toMatchObject({
        user: { id: fixtures.owner.id },
        organizationId: fixtures.orgA.id,
      });
    });
  });

  describe("Domain Settings — OWNER", () => {
    it("saves domain settings and stays authenticated", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);

      const result = await updateDomainSettingsAction({ error: null }, domainForm());
      expect(result.error).toBeNull();
      expect(result.message).toBe("Domain settings saved.");

      const row = await prisma.organizationDomainSettings.findUnique({ where: { organizationId: fixtures.orgA.id } });
      expect(row).not.toBeNull();

      await expect(getCurrentMembership()).resolves.toMatchObject({
        user: { id: fixtures.owner.id },
        organizationId: fixtures.orgA.id,
      });
    });
  });

  describe("Existing unrelated action — createClientAction", () => {
    it("behavior is unchanged: a Client is still created, and the user remains authenticated immediately after — the exact pre-existing action production smoke testing found exhibiting this symptom", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);

      const formData = new FormData();
      const clientName = `Stability Test Client ${fixtures.runId}`;
      formData.set("name", clientName);

      // createClientAction redirects on success (unchanged) — a thrown
      // RedirectSignal to /clients, never /login.
      let caught: unknown;
      try {
        await createClientAction({ error: null }, formData);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RedirectSignal);
      expect((caught as RedirectSignal).message).toContain("REDIRECT:/clients");

      const created = await prisma.client.findFirst({ where: { name: clientName } });
      expect(created).not.toBeNull();

      const { user, organizationId } = await getCurrentUserOrganization();
      expect(user.id).toBe(fixtures.owner.id);
      expect(organizationId).toBe(fixtures.orgA.id);
    });
  });
});
