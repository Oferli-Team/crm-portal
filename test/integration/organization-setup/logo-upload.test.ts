import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { uploadCompanyLogoAction } from "@/app/(dashboard)/settings/company/actions";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { setLogoUploadShouldFail, resetLogoStorageMock, removedLogoUrls } from "../../support/logo-storage-mock";

function makeLogoFormData(name = "logo.png", type = "image/png", size = 1024): FormData {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array(size)], name, { type }));
  return fd;
}

async function seedProfile(organizationId: string): Promise<void> {
  await prisma.organizationProfile.create({
    data: {
      organizationId,
      legalName: "Acme Legal Name LLC",
      country: "United States",
      currency: "USD",
      timezone: "America/New_York",
    },
  });
}

describe("Company logo upload — Sale-Ready Phase A.1 (Business Identity), PR4", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(async () => {
    resetAuthMock();
    resetLogoStorageMock();
    await prisma.organizationProfile.deleteMany({
      where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } },
    });
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("OWNER can upload a valid PNG logo, persisted to OrganizationProfile.logoUrl", async () => {
    await seedProfile(fixtures.orgA.id);
    actAs(fixtures.owner, fixtures.orgA.id);

    const result = await uploadCompanyLogoAction({ error: null }, makeLogoFormData());
    expect(result.error).toBeNull();

    const profile = await prisma.organizationProfile.findUniqueOrThrow({
      where: { organizationId: fixtures.orgA.id },
    });
    expect(profile.logoUrl).toMatch(/^https:\/\/mock\.supabase\.test\/storage\/v1\/object\/public\/logos\//);
  });

  it.each([
    ["image/jpeg", "logo.jpg"],
    ["image/webp", "logo.webp"],
  ])("OWNER can upload a valid %s logo", async (type, name) => {
    await seedProfile(fixtures.orgA.id);
    actAs(fixtures.owner, fixtures.orgA.id);

    const result = await uploadCompanyLogoAction({ error: null }, makeLogoFormData(name, type));
    expect(result.error).toBeNull();
  });

  it("MEMBER cannot upload a logo — same OWNER-only boundary as the text-field form", async () => {
    await seedProfile(fixtures.orgA.id);
    actAs(fixtures.member, fixtures.orgA.id);

    const result = await uploadCompanyLogoAction({ error: null }, makeLogoFormData());
    expect(result.error).toBe("Only the organization owner can update company details.");

    const profile = await prisma.organizationProfile.findUniqueOrThrow({
      where: { organizationId: fixtures.orgA.id },
    });
    expect(profile.logoUrl).toBeNull();
  });

  it("ADMIN cannot upload a logo either", async () => {
    await seedProfile(fixtures.orgA.id);
    actAs(fixtures.admin, fixtures.orgA.id);

    const result = await uploadCompanyLogoAction({ error: null }, makeLogoFormData());
    expect(result.error).toBe("Only the organization owner can update company details.");
  });

  it("rejects an SVG (can carry embedded scripts), even with an internally-consistent extension/MIME pair", async () => {
    await seedProfile(fixtures.orgA.id);
    actAs(fixtures.owner, fixtures.orgA.id);

    const result = await uploadCompanyLogoAction({ error: null }, makeLogoFormData("icon.svg", "image/svg+xml"));
    expect(result.error).toBe("Only PNG, JPEG, and WebP images are supported.");

    const profile = await prisma.organizationProfile.findUniqueOrThrow({
      where: { organizationId: fixtures.orgA.id },
    });
    expect(profile.logoUrl).toBeNull();
  });

  it("rejects a GIF", async () => {
    await seedProfile(fixtures.orgA.id);
    actAs(fixtures.owner, fixtures.orgA.id);

    const result = await uploadCompanyLogoAction({ error: null }, makeLogoFormData("animated.gif", "image/gif"));
    expect(result.error).toBe("Only PNG, JPEG, and WebP images are supported.");
  });

  it("rejects any other disallowed MIME type (e.g. a PDF)", async () => {
    await seedProfile(fixtures.orgA.id);
    actAs(fixtures.owner, fixtures.orgA.id);

    const result = await uploadCompanyLogoAction({ error: null }, makeLogoFormData("doc.pdf", "application/pdf"));
    expect(result.error).toBe("Only PNG, JPEG, and WebP images are supported.");
  });

  it("rejects an oversized file (one byte over the 2 MB limit)", async () => {
    await seedProfile(fixtures.orgA.id);
    actAs(fixtures.owner, fixtures.orgA.id);

    const result = await uploadCompanyLogoAction(
      { error: null },
      makeLogoFormData("logo.png", "image/png", 2 * 1024 * 1024 + 1),
    );
    expect(result.error).toBe("This file is too large. Maximum size is 2 MB.");

    const profile = await prisma.organizationProfile.findUniqueOrThrow({
      where: { organizationId: fixtures.orgA.id },
    });
    expect(profile.logoUrl).toBeNull();
  });

  it("rejects an upload when no OrganizationProfile row exists yet, with a clear, actionable message", async () => {
    // Deliberately no seedProfile() call — org B has no OrganizationProfile row.
    actAs(fixtures.orgBOwner, fixtures.orgB.id);

    const result = await uploadCompanyLogoAction({ error: null }, makeLogoFormData());
    expect(result.error).toBe("Save your business details before uploading a logo.");
  });

  it("rejects a missing file", async () => {
    await seedProfile(fixtures.orgA.id);
    actAs(fixtures.owner, fixtures.orgA.id);

    const result = await uploadCompanyLogoAction({ error: null }, new FormData());
    expect(result.error).toBe("Please choose a file to upload.");
  });

  it("uploading a second logo replaces logoUrl and removes the previous Storage object as best-effort cleanup", async () => {
    await seedProfile(fixtures.orgA.id);
    actAs(fixtures.owner, fixtures.orgA.id);

    const first = await uploadCompanyLogoAction({ error: null }, makeLogoFormData());
    expect(first.error).toBeNull();
    const afterFirst = await prisma.organizationProfile.findUniqueOrThrow({
      where: { organizationId: fixtures.orgA.id },
    });
    const firstLogoUrl = afterFirst.logoUrl;
    expect(firstLogoUrl).not.toBeNull();

    const second = await uploadCompanyLogoAction({ error: null }, makeLogoFormData());
    expect(second.error).toBeNull();

    expect(removedLogoUrls).toContain(firstLogoUrl);

    const afterSecond = await prisma.organizationProfile.findUniqueOrThrow({
      where: { organizationId: fixtures.orgA.id },
    });
    expect(afterSecond.logoUrl).not.toBe(firstLogoUrl);
  });

  it("Storage upload failure is reported without ever writing logoUrl", async () => {
    await seedProfile(fixtures.orgA.id);
    actAs(fixtures.owner, fixtures.orgA.id);
    setLogoUploadShouldFail(true);

    const result = await uploadCompanyLogoAction({ error: null }, makeLogoFormData());
    expect(result.error).toBe("Failed to upload the logo. Please try again.");

    const profile = await prisma.organizationProfile.findUniqueOrThrow({
      where: { organizationId: fixtures.orgA.id },
    });
    expect(profile.logoUrl).toBeNull();
  });

  it("a MEMBER's forbidden attempt never reaches Storage at all (no upload side effect)", async () => {
    await seedProfile(fixtures.orgA.id);
    actAs(fixtures.member, fixtures.orgA.id);

    await uploadCompanyLogoAction({ error: null }, makeLogoFormData());
    expect(removedLogoUrls).toHaveLength(0);
  });
});
