import { prisma } from "@/lib/prisma";
import type { ParsedCompanyProfileInput } from "@/lib/validation/company-profile";

export type CompanyProfileData = {
  /** Always present — Organization.name, the app's existing display name. */
  displayName: string;
  /** null until the OWNER has submitted this step's form at least once. */
  legalName: string | null;
  country: string | null;
  currency: string | null;
  timezone: string | null;

  // Sale-Ready Phase A.1 (Business Identity), PR2 — all nine null until
  // explicitly set (same "null means not yet provided" contract as
  // legalName/country/currency/timezone above), read by no UI yet.
  supportEmail: string | null;
  website: string | null;
  phone: string | null;
  taxId: string | null;
  brandColor: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;

  // Sale-Ready Phase A.1 (Business Identity), PR5 — read-only here; never
  // written by upsertCompanyProfile (see logo-mutations.ts's own
  // uploadOrganizationLogo, the only writer of this field).
  logoUrl: string | null;
};

/** Read-only — never role-gated (any member may view), matching authorization.ts's own documented boundary. */
export async function getCompanyProfile(organizationId: string): Promise<CompanyProfileData> {
  const [organization, profile] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true } }),
    prisma.organizationProfile.findUnique({ where: { organizationId } }),
  ]);

  return {
    displayName: organization.name,
    legalName: profile?.legalName ?? null,
    country: profile?.country ?? null,
    currency: profile?.currency ?? null,
    timezone: profile?.timezone ?? null,
    supportEmail: profile?.supportEmail ?? null,
    website: profile?.website ?? null,
    phone: profile?.phone ?? null,
    taxId: profile?.taxId ?? null,
    brandColor: profile?.brandColor ?? null,
    streetAddress: profile?.streetAddress ?? null,
    city: profile?.city ?? null,
    state: profile?.state ?? null,
    postalCode: profile?.postalCode ?? null,
    logoUrl: profile?.logoUrl ?? null,
  };
}

/**
 * OWNER-only — callers must call assertCanManageCompanyProfile() first
 * (this function itself does no role check, mirroring
 * getOrCreateOrganizationId's own "authorization happens at the call
 * site, this is pure data access" shape). Two tables, one transaction:
 * Organization.name (the existing display name field) and
 * OrganizationProfile's own new columns either both update, or neither
 * does.
 */
export async function upsertCompanyProfile(organizationId: string, input: ParsedCompanyProfileInput): Promise<void> {
  // Sale-Ready Phase A.1 (Business Identity), PR2 — shared by both the
  // `update` and `create` branches below so the two can never drift out
  // of sync with each other as more fields get added here.
  const profileFields = {
    legalName: input.legalName,
    country: input.country,
    currency: input.currency,
    timezone: input.timezone,
    supportEmail: input.supportEmail,
    website: input.website,
    phone: input.phone,
    taxId: input.taxId,
    brandColor: input.brandColor,
    streetAddress: input.streetAddress,
    city: input.city,
    state: input.state,
    postalCode: input.postalCode,
  };

  await prisma.$transaction([
    prisma.organization.update({ where: { id: organizationId }, data: { name: input.displayName } }),
    prisma.organizationProfile.upsert({
      where: { organizationId },
      update: profileFields,
      create: { organizationId, ...profileFields },
    }),
  ]);
}
