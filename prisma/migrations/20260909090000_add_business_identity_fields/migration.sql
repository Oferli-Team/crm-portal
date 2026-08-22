-- Sale-Ready Phase A.1 (Business Identity) — PR1, schema only.
-- Purely additive: every new column is nullable, no default beyond NULL,
-- no existing column touched. An organization that sets none of these
-- keeps working exactly as it does today; nothing reads them yet.
-- AlterTable
ALTER TABLE "OrganizationProfile" ADD COLUMN     "brandColor" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "logoUrl" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "postalCode" TEXT,
ADD COLUMN     "state" TEXT,
ADD COLUMN     "streetAddress" TEXT,
ADD COLUMN     "supportEmail" TEXT,
ADD COLUMN     "taxId" TEXT,
ADD COLUMN     "website" TEXT;
