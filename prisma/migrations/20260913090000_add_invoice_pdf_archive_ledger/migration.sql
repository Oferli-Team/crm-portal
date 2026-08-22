/*
  Invoice System Slice 3, sub-PR 3b — durable archival-object ledger
  (prisma/schema.prisma's own InvoicePdfArchiveObject doc comment). Purely
  additive: one new enum, one new table, its indexes/constraints, and two
  new foreign keys — no existing column, table, or constraint is altered,
  renamed, or dropped. Every application code path that reads/writes this
  table is new in this same sub-PR (src/lib/invoices/pdf/issue-invoice.ts);
  no pre-existing row of any kind is affected by this migration.

  No external/staging/production database was touched applying this
  migration — it was only ever applied against this repo's local,
  ephemeral PGlite-backed test harness (test/support/local-postgres.ts)
  while authoring it.
*/

-- CreateEnum
CREATE TYPE "InvoicePdfArchiveObjectStatus" AS ENUM ('PENDING_UPLOAD', 'REFERENCED', 'CLEANUP_PENDING', 'CLEANED');

-- CreateTable
CREATE TABLE "InvoicePdfArchiveObject" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "invoiceId" UUID,
    "documentVersion" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "status" "InvoicePdfArchiveObjectStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "referencedAt" TIMESTAMP(3),
    "cleanedAt" TIMESTAMP(3),
    "cleanupLockedAt" TIMESTAMP(3),
    "cleanupClaimToken" UUID,
    "cleanupAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastCleanupFailureCategory" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoicePdfArchiveObject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoicePdfArchiveObject_storagePath_key" ON "InvoicePdfArchiveObject"("storagePath");

-- CreateIndex
CREATE INDEX "InvoicePdfArchiveObject_organizationId_idx" ON "InvoicePdfArchiveObject"("organizationId");

-- CreateIndex
CREATE INDEX "InvoicePdfArchiveObject_invoiceId_idx" ON "InvoicePdfArchiveObject"("invoiceId");

-- CreateIndex
CREATE INDEX "InvoicePdfArchiveObject_status_createdAt_idx" ON "InvoicePdfArchiveObject"("status", "createdAt");

-- CreateIndex
CREATE INDEX "InvoicePdfArchiveObject_status_cleanupLockedAt_idx" ON "InvoicePdfArchiveObject"("status", "cleanupLockedAt");

-- AddForeignKey
ALTER TABLE "InvoicePdfArchiveObject" ADD CONSTRAINT "InvoicePdfArchiveObject_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicePdfArchiveObject" ADD CONSTRAINT "InvoicePdfArchiveObject_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
