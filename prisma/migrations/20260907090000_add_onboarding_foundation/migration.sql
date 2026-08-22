-- Onboarding Stage 2 (docs/onboarding-architecture.md §9/§19). Purely
-- additive: one new enum, one new table, its two indexes, and its one
-- foreign key. Nothing about any existing table changes. No backfill is
-- possible or needed — every existing Organization simply has zero rows
-- here on day one, which correctly means "nothing has been explicitly
-- skipped or dismissed yet" (see the model's own schema.prisma comment).

-- CreateEnum
CREATE TYPE "OnboardingStepKey" AS ENUM ('WELCOME', 'CREATE_CLIENT', 'CREATE_PROJECT', 'CREATE_TASK', 'INVITE_TEAMMATE', 'INVITE_PORTAL_USER', 'REVIEW_BILLING', 'FINISH');

-- CreateTable
CREATE TABLE "OrganizationOnboardingStep" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "step" "OnboardingStepKey" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationOnboardingStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationOnboardingStep_organizationId_idx" ON "OrganizationOnboardingStep"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationOnboardingStep_organizationId_step_key" ON "OrganizationOnboardingStep"("organizationId", "step");

-- AddForeignKey
ALTER TABLE "OrganizationOnboardingStep" ADD CONSTRAINT "OrganizationOnboardingStep_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
