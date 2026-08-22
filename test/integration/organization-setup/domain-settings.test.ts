import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { updateDomainSettingsAction } from "@/app/(dashboard)/settings/domain/actions";
import { getDomainSettings, getGeneratedSubdomain } from "@/lib/organization-setup/domain-settings";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { testSlug } from "../../support/run-id";

function domainForm(customDomain = ""): FormData {
  const fd = new FormData();
  fd.set("customDomain", customDomain);
  return fd;
}

describe("Domain Settings — Customer Setup Wizard (Stage 6.2)", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(async () => {
    resetAuthMock();
    await prisma.organizationDomainSettings.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("getGeneratedSubdomain is a pure computation from the org's own slug — no storage involved", () => {
    expect(getGeneratedSubdomain("acme-inc")).toMatch(/^acme-inc\./);
  });

  it("OWNER can save with no custom domain — a row is still created, PENDING by default, confirming the step without entering one", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await updateDomainSettingsAction({ error: null }, domainForm());
    expect(result.error).toBeNull();

    const row = await prisma.organizationDomainSettings.findUniqueOrThrow({ where: { organizationId: fixtures.orgA.id } });
    expect(row.customDomain).toBeNull();
    expect(row.verificationStatus).toBe("PENDING");
  });

  it("OWNER can set a custom domain, always landing on PENDING — no real verification runs", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const domain = `${testSlug("owner-domain")}.example.com`;
    const result = await updateDomainSettingsAction({ error: null }, domainForm(domain));
    expect(result.error).toBeNull();

    const settings = await getDomainSettings(fixtures.orgA.id);
    expect(settings.customDomain).toBe(domain);
    expect(settings.verificationStatus).toBe("PENDING");
  });

  it("changing an already-set custom domain resets verificationStatus back to PENDING", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const first = `${testSlug("first-domain")}.example.com`;
    const second = `${testSlug("second-domain")}.example.com`;
    await updateDomainSettingsAction({ error: null }, domainForm(first));
    await updateDomainSettingsAction({ error: null }, domainForm(second));

    const rows = await prisma.organizationDomainSettings.findMany({ where: { organizationId: fixtures.orgA.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].customDomain).toBe(second);
    expect(rows[0].verificationStatus).toBe("PENDING");
  });

  it("MEMBER cannot update domain settings", async () => {
    actAs(fixtures.member, fixtures.orgA.id);
    const result = await updateDomainSettingsAction({ error: null }, domainForm());
    expect(result.error).toBe("Only the organization owner can update domain settings.");
    const row = await prisma.organizationDomainSettings.findUnique({ where: { organizationId: fixtures.orgA.id } });
    expect(row).toBeNull();
  });

  it("a Client Portal identity has no reachable action here at all", async () => {
    actAs({ id: fixtures.portalUser.id, email: fixtures.portalUser.email }, fixtures.orgA.id);
    await expect(updateDomainSettingsAction({ error: null }, domainForm())).rejects.toThrow("REDIRECT:/portal");
  });

  it("two organizations can never claim the same custom domain — the second attempt gets a controlled field error, not a crash", async () => {
    const domain = `${testSlug("shared-domain")}.example.com`;

    actAs(fixtures.owner, fixtures.orgA.id);
    const first = await updateDomainSettingsAction({ error: null }, domainForm(domain));
    expect(first.error).toBeNull();

    actAs(fixtures.orgBOwner, fixtures.orgB.id);
    const second = await updateDomainSettingsAction({ error: null }, domainForm(domain));
    expect(second.fieldErrors?.customDomain).toBeTruthy();

    const orgBSettings = await getDomainSettings(fixtures.orgB.id);
    expect(orgBSettings.customDomain).toBeNull();
  });

  it("Organization A cannot access Organization B's domain settings", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const domain = `${testSlug("isolated-domain")}.example.com`;
    await updateDomainSettingsAction({ error: null }, domainForm(domain));

    const orgBSettings = await getDomainSettings(fixtures.orgB.id);
    expect(orgBSettings.customDomain).toBeNull();

    const orgASettings = await getDomainSettings(fixtures.orgA.id);
    expect(orgASettings.customDomain).toBe(domain);
  });
});
