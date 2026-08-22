import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { updateCompanyProfileAction } from "@/app/(dashboard)/settings/company/actions";
import { getCompanyProfile } from "@/lib/organization-setup/company-profile";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";

type CompanyFormFields = Partial<{
  legalName: string;
  displayName: string;
  country: string;
  currency: string;
  timezone: string;
  // Sale-Ready Phase A.1 (Business Identity), PR2.
  supportEmail: string;
  website: string;
  phone: string;
  taxId: string;
  brandColor: string;
  streetAddress: string;
  city: string;
  state: string;
  postalCode: string;
}>;

function companyForm(fields: CompanyFormFields = {}): FormData {
  const fd = new FormData();
  fd.set("legalName", fields.legalName ?? "Acme Legal Name LLC");
  fd.set("displayName", fields.displayName ?? "Acme");
  fd.set("country", fields.country ?? "United States");
  fd.set("currency", fields.currency ?? "USD");
  fd.set("timezone", fields.timezone ?? "America/New_York");
  // Optional fields are only ever set on the FormData when the caller
  // explicitly provides them — omitting the key entirely (rather than
  // setting an empty string) matches what a real form without these
  // inputs yet actually sends, and both onward code paths behave
  // identically for that case (see parseCompanyProfileForm's own
  // formData.get() ?? "" fallback).
  const optionalFields: (keyof CompanyFormFields)[] = [
    "supportEmail",
    "website",
    "phone",
    "taxId",
    "brandColor",
    "streetAddress",
    "city",
    "state",
    "postalCode",
  ];
  for (const key of optionalFields) {
    const value = fields[key];
    if (value !== undefined) fd.set(key, value);
  }
  return fd;
}

describe("Company Profile — Customer Setup Wizard (Stage 6.2)", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(async () => {
    resetAuthMock();
    await prisma.organizationProfile.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
    // Restore Organization.name in case a test changed it (Organization
    // itself is fixture-owned, not test-owned — never deleted here).
    await prisma.organization.update({ where: { id: fixtures.orgA.id }, data: { name: "Test Org A" } });
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("OWNER can create the company profile, updating Organization.name and OrganizationProfile atomically", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await updateCompanyProfileAction({ error: null }, companyForm({ displayName: "Acme Renamed" }));
    expect(result.error).toBeNull();
    expect(result.message).toBeTruthy();

    const organization = await prisma.organization.findUniqueOrThrow({ where: { id: fixtures.orgA.id } });
    expect(organization.name).toBe("Acme Renamed");

    const profile = await prisma.organizationProfile.findUniqueOrThrow({ where: { organizationId: fixtures.orgA.id } });
    expect(profile.legalName).toBe("Acme Legal Name LLC");
    expect(profile.country).toBe("United States");
    expect(profile.currency).toBe("USD");
    expect(profile.timezone).toBe("America/New_York");
  });

  it("OWNER can update an existing company profile (upsert, not a duplicate row)", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    await updateCompanyProfileAction({ error: null }, companyForm({ legalName: "First Legal Name" }));
    await updateCompanyProfileAction({ error: null }, companyForm({ legalName: "Updated Legal Name" }));

    const rows = await prisma.organizationProfile.findMany({ where: { organizationId: fixtures.orgA.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].legalName).toBe("Updated Legal Name");
  });

  describe("Business Identity fields (Sale-Ready Phase A.1, PR2)", () => {
    it("OWNER can set every new field in one submission, persisted and read back via getCompanyProfile", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const result = await updateCompanyProfileAction(
        { error: null },
        companyForm({
          supportEmail: "support@acme.com",
          website: "https://acme.com",
          phone: "+1 555-0100",
          taxId: "EU123456789",
          brandColor: "#0F172A",
          streetAddress: "123 Main St",
          city: "Springfield",
          state: "IL",
          postalCode: "62704",
        }),
      );
      expect(result.error).toBeNull();

      const profile = await getCompanyProfile(fixtures.orgA.id);
      expect(profile.supportEmail).toBe("support@acme.com");
      expect(profile.website).toBe("https://acme.com");
      expect(profile.phone).toBe("+1 555-0100");
      expect(profile.taxId).toBe("EU123456789");
      expect(profile.brandColor).toBe("#0F172A");
      expect(profile.streetAddress).toBe("123 Main St");
      expect(profile.city).toBe("Springfield");
      expect(profile.state).toBe("IL");
      expect(profile.postalCode).toBe("62704");
    });

    it("omitting every new field (the exact shape today's real form still sends) leaves them all null — no regression for an existing submission", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const result = await updateCompanyProfileAction({ error: null }, companyForm());
      expect(result.error).toBeNull();

      const profile = await getCompanyProfile(fixtures.orgA.id);
      expect(profile.supportEmail).toBeNull();
      expect(profile.website).toBeNull();
      expect(profile.phone).toBeNull();
      expect(profile.taxId).toBeNull();
      expect(profile.brandColor).toBeNull();
      expect(profile.streetAddress).toBeNull();
      expect(profile.city).toBeNull();
      expect(profile.state).toBeNull();
      expect(profile.postalCode).toBeNull();
    });

    it("clearing a previously-set field (submitting an empty string) writes null, not an empty string", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      await updateCompanyProfileAction({ error: null }, companyForm({ supportEmail: "support@acme.com", phone: "+1 555-0100" }));
      let profile = await getCompanyProfile(fixtures.orgA.id);
      expect(profile.supportEmail).toBe("support@acme.com");
      expect(profile.phone).toBe("+1 555-0100");

      await updateCompanyProfileAction({ error: null }, companyForm({ supportEmail: "", phone: "" }));
      profile = await getCompanyProfile(fixtures.orgA.id);
      expect(profile.supportEmail).toBeNull();
      expect(profile.phone).toBeNull();
    });

    it("an invalid optional field (malformed brandColor) rejects the whole submission and writes nothing, same as an invalid required field already does", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const result = await updateCompanyProfileAction({ error: null }, companyForm({ brandColor: "not-a-color" }));
      expect(result.fieldErrors?.brandColor).toBeTruthy();
      const profile = await prisma.organizationProfile.findUnique({ where: { organizationId: fixtures.orgA.id } });
      expect(profile).toBeNull();
    });

    it("MEMBER cannot write any new field either — same OWNER-only boundary, unchanged", async () => {
      actAs(fixtures.member, fixtures.orgA.id);
      const result = await updateCompanyProfileAction({ error: null }, companyForm({ supportEmail: "support@acme.com" }));
      expect(result.error).toBe("Only the organization owner can update company details.");
      const profile = await prisma.organizationProfile.findUnique({ where: { organizationId: fixtures.orgA.id } });
      expect(profile).toBeNull();
    });
  });

  it("ADMIN cannot update company settings", async () => {
    actAs(fixtures.admin, fixtures.orgA.id);
    const result = await updateCompanyProfileAction({ error: null }, companyForm());
    expect(result.error).toBe("Only the organization owner can update company details.");
    const profile = await prisma.organizationProfile.findUnique({ where: { organizationId: fixtures.orgA.id } });
    expect(profile).toBeNull();
  });

  it("MEMBER cannot update company settings", async () => {
    actAs(fixtures.member, fixtures.orgA.id);
    const result = await updateCompanyProfileAction({ error: null }, companyForm());
    expect(result.error).toBe("Only the organization owner can update company details.");
    const profile = await prisma.organizationProfile.findUnique({ where: { organizationId: fixtures.orgA.id } });
    expect(profile).toBeNull();
  });

  it("rejects an invalid submission with field errors, and writes nothing", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await updateCompanyProfileAction({ error: null }, companyForm({ currency: "NOTREAL" }));
    expect(result.fieldErrors?.currency).toBeTruthy();
    const profile = await prisma.organizationProfile.findUnique({ where: { organizationId: fixtures.orgA.id } });
    expect(profile).toBeNull();
  });

  it("Organization A cannot access Organization B's company profile", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    await updateCompanyProfileAction({ error: null }, companyForm({ legalName: "Org A Legal Name" }));

    // orgBOwner reads/writes only their own org — resolving via
    // getCompanyProfile(organizationId) exactly like the real page does.
    const orgBProfile = await getCompanyProfile(fixtures.orgB.id);
    expect(orgBProfile.legalName).toBeNull();

    const orgAProfile = await getCompanyProfile(fixtures.orgA.id);
    expect(orgAProfile.legalName).toBe("Org A Legal Name");
  });

  it("a Client Portal identity has no reachable action here at all — getCurrentMembership() throws for a portal-only identity's org resolution", async () => {
    // Mirrors the structural guarantee every other staff-only Server
    // Action in this app relies on (docs/onboarding-architecture.md §13):
    // a PortalUser is never resolvable via getCurrentMembership() at all
    // (see current-user.ts's own getOrCreateUser() redirect-to-/portal
    // guard) — there is no code path for a portal identity to reach this
    // action's role check in the first place.
    actAs({ id: fixtures.portalUser.id, email: fixtures.portalUser.email }, fixtures.orgA.id);
    await expect(updateCompanyProfileAction({ error: null }, companyForm())).rejects.toThrow("REDIRECT:/portal");
  });
});
