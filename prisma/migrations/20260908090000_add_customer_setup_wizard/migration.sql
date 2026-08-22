-- Customer Setup Wizard (Stage 6.2). Purely additive: three new
-- OnboardingStepKey enum values (slotted between WELCOME and
-- CREATE_CLIENT, matching src/lib/onboarding/steps.ts's own
-- ONBOARDING_STEP_ORDER), one new enum for an inert domain-verification
-- placeholder, and three new one-row-per-Organization tables. Nothing
-- about any existing table changes.

-- AlterEnum
ALTER TYPE "OnboardingStepKey" ADD VALUE 'COMPANY_PROFILE' BEFORE 'CREATE_CLIENT';
ALTER TYPE "OnboardingStepKey" ADD VALUE 'PAYMENT_DETAILS' AFTER 'COMPANY_PROFILE';
ALTER TYPE "OnboardingStepKey" ADD VALUE 'DOMAIN_SETUP' AFTER 'PAYMENT_DETAILS';

-- CreateEnum
CREATE TYPE "DomainVerificationStatus" AS ENUM ('PENDING', 'VERIFIED');

-- CreateTable
CREATE TABLE "OrganizationProfile" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "legalName" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationPaymentDetails" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountHolder" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "swiftBic" TEXT NOT NULL,
    "paymentInstructions" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationPaymentDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationDomainSettings" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "customDomain" TEXT,
    "verificationStatus" "DomainVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationDomainSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationProfile_organizationId_key" ON "OrganizationProfile"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationPaymentDetails_organizationId_key" ON "OrganizationPaymentDetails"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationDomainSettings_organizationId_key" ON "OrganizationDomainSettings"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationDomainSettings_customDomain_key" ON "OrganizationDomainSettings"("customDomain");

-- AddForeignKey
ALTER TABLE "OrganizationProfile" ADD CONSTRAINT "OrganizationProfile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationPaymentDetails" ADD CONSTRAINT "OrganizationPaymentDetails_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationDomainSettings" ADD CONSTRAINT "OrganizationDomainSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
