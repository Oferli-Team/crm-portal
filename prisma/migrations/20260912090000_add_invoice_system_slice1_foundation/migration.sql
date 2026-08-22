/*
  Invoice System Slice 1 — EXPAND schema (docs/invoicing-architecture.md
  §4, §12 step 1). Adds every Slice 1 table/column/enum additively:
  InvoiceLineItem, InvoiceEmailAttempt, Client's optional billing-identity
  fields, and Invoice's discount/tax/calculated-totals/finalization/
  archival columns. Old application code deployed against this schema sees
  no behavioral change — nothing here removes, renames, or narrows an
  existing column, and every new Invoice column is either defaulted
  (`discountType`, `taxLabel`, `documentVersion`) or nullable.

  `subtotal`/`discountAmount`/`taxAmount` are deliberately left NULLABLE in
  this migration — NOT §4's final contracted shape (non-null, defaulted).
  This is the same expand/backfill/contract discipline already proven by
  `20260911090000_repair_invoice_organization_scope` for
  `Invoice.organizationId`: an old application version could still be
  running during a rolling deploy window and insert a row before this
  slice's dual-write path exists everywhere, and a blind NOT NULL here
  would risk exactly that in-flight write failing. Slice 5 owns the
  eventual NOT NULL contract (docs/invoicing-architecture.md §12 step 4),
  once dual-write application code has been live for a full deploy cycle —
  never assumed to land atomically with this migration.

  Immediately after the new Invoice columns are added, this migration
  performs a deterministic, one-time backfill of every pre-existing row:
  `subtotal = amount`, `discountAmount = 0`, `taxAmount = 0` — a pure copy
  of an already-existing fact (`amount`), never a guess, and never
  fabricating any `InvoiceLineItem` row (every pre-existing invoice was
  created before line items existed, so it correctly remains a flat
  invoice with zero line items — see §4.6's classification table).
  `amount` itself is never altered by this migration. A post-backfill
  guard then verifies every row actually satisfies that invariant, and
  aborts loudly (a fixed, count-only `RAISE EXCEPTION`, never a row id or
  other row content) if not — mirroring
  `20260911090000_repair_invoice_organization_scope`'s own guard/verify
  discipline. Given this migration itself is what first creates these
  columns (every pre-existing row's `subtotal` is NULL going in), this
  guard should be unreachable; it exists anyway as the same defensive,
  self-verifying check that migration set as this repo's precedent for a
  backfill with real consequences if silently wrong.

  This migration deliberately contains NO explicit top-level BEGIN/COMMIT.
  This follows the same choice `20260911090000_repair_invoice_organization_scope`
  already made for its own guarded/backfilling migration — see that
  migration's own header comment for the exact, one-time empirical
  reproduction behind it (Prisma 7.9.1, a real `prisma migrate deploy`
  subprocess against a PGlite-backed Postgres instance): for that specific
  reproduction, Prisma Migrate wrapped that migration.sql file's
  statements in its own transaction, and adding an explicit BEGIN/COMMIT
  there was found to only degrade the surfaced error message without
  adding any additional safety. This migration reuses that same
  conclusion rather than repeating the reproduction here — it is NOT a
  general guarantee that every Prisma version, migration file, or
  deployment environment wraps migrations in a transaction identically;
  a real deployment against any actual target database remains a
  separate, controlled operator step (§12) that should confirm this
  behavior in that environment rather than assume it.

  Explicitly NOT part of this migration (out of Slice 1's scope, per
  docs/invoicing-architecture.md §12/§14):
  - No NOT NULL/contract-phase change to subtotal/discountAmount/taxAmount
    (Slice 5).
  - No change to the existing `@@unique([clientId, invoiceNumber])`
    constraint (Slice 5, gated on its own real-data collision preflight,
    §4.5/§12.5).
  - No partial unique index enforcing "at most one PENDING
    InvoiceEmailAttempt per invoice" (Slice 4 owns it — it only matters
    once a real send path exists).
  - No PDF Storage operation of any kind.
  - No external/staging/production database was touched applying this
    migration — it was only ever applied against this repo's local,
    ephemeral PGlite-backed test harness (test/support/local-postgres.ts)
    while authoring it.
*/

-- CreateEnum
CREATE TYPE "InvoiceDiscountType" AS ENUM ('NONE', 'PERCENTAGE', 'FIXED');

-- CreateEnum
CREATE TYPE "InvoiceTaxLabel" AS ENUM ('TAX', 'VAT', 'GST');

-- CreateEnum
CREATE TYPE "InvoiceEmailAttemptStatus" AS ENUM ('PENDING', 'ACCEPTED', 'FAILED', 'UNKNOWN');

-- AlterTable: Client optional billing identity (docs/invoicing-architecture.md §4.4).
-- All nullable, never backfilled — no source-of-truth data exists to backfill from.
ALTER TABLE "Client" ADD COLUMN     "billingLegalName" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "postalCode" TEXT,
ADD COLUMN     "state" TEXT,
ADD COLUMN     "streetAddress" TEXT,
ADD COLUMN     "taxId" TEXT;

-- AlterTable: Invoice Slice 1 transitional columns (docs/invoicing-architecture.md §4.1/§12).
ALTER TABLE "Invoice" ADD COLUMN     "discountAmount" DECIMAL(10,2),
ADD COLUMN     "discountType" "InvoiceDiscountType" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "discountValue" DECIMAL(10,2),
ADD COLUMN     "documentVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "finalizedAt" TIMESTAMP(3),
ADD COLUMN     "internalNotes" TEXT,
ADD COLUMN     "issuerSnapshot" JSONB,
ADD COLUMN     "pdfGeneratedAt" TIMESTAMP(3),
ADD COLUMN     "pdfStoragePath" TEXT,
ADD COLUMN     "recipientSnapshot" JSONB,
ADD COLUMN     "subtotal" DECIMAL(10,2),
ADD COLUMN     "taxAmount" DECIMAL(10,2),
ADD COLUMN     "taxLabel" "InvoiceTaxLabel" NOT NULL DEFAULT 'TAX',
ADD COLUMN     "taxRatePercent" DECIMAL(5,2);

-- Deterministic legacy backfill (docs/invoicing-architecture.md §12 step 2):
-- a pure copy of the already-existing `amount` fact into the new nullable
-- `subtotal` column, and a fixed `0` into `discountAmount`/`taxAmount`, for
-- every pre-existing row. COALESCE means only a currently-null value is
-- ever filled — an already-populated value (not possible on first
-- application of this migration, since these columns were just created
-- above, but kept for the same idempotent-by-construction discipline as
-- `20260911090000_repair_invoice_organization_scope`'s own backfill) is
-- never overwritten. No `InvoiceLineItem` row is ever created here. `amount`
-- itself is never written by this statement.
UPDATE "Invoice"
SET
  "subtotal" = COALESCE("subtotal", "amount"),
  "discountAmount" = COALESCE("discountAmount", 0),
  "taxAmount" = COALESCE("taxAmount", 0)
WHERE "subtotal" IS NULL OR "discountAmount" IS NULL OR "taxAmount" IS NULL;

-- Post-backfill guard: every Invoice row existing at migration time must
-- now satisfy subtotal = amount, discountAmount = 0, taxAmount = 0. Given
-- the backfill above, this should be unreachable — kept anyway as the same
-- defensive, self-verifying check
-- `20260911090000_repair_invoice_organization_scope` established as this
-- repo's precedent for a backfill with real consequences if silently
-- wrong. The raised error contains only a count, never a row id or any
-- other row content.
DO $$
DECLARE
  inconsistent_count integer;
BEGIN
  SELECT COUNT(*) INTO inconsistent_count
  FROM "Invoice"
  WHERE "subtotal" IS DISTINCT FROM "amount"
     OR "discountAmount" IS DISTINCT FROM 0
     OR "taxAmount" IS DISTINCT FROM 0;

  IF inconsistent_count > 0 THEN
    RAISE EXCEPTION 'Invoice Slice 1 legacy backfill aborted: % invoice row(s) failed the post-backfill consistency guard (subtotal must equal amount, discountAmount and taxAmount must both be 0 for every pre-existing row).', inconsistent_count;
  END IF;
END $$;

-- CreateTable
CREATE TABLE "InvoiceLineItem" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "lineTotal" DECIMAL(10,2) NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceEmailAttempt" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "status" "InvoiceEmailAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "failureReason" TEXT,
    "requestedByUserId" UUID,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "providerAcceptedAt" TIMESTAMP(3),

    CONSTRAINT "InvoiceEmailAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLineItem_invoiceId_position_key" ON "InvoiceLineItem"("invoiceId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceEmailAttempt_idempotencyKey_key" ON "InvoiceEmailAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "InvoiceEmailAttempt_invoiceId_attemptedAt_idx" ON "InvoiceEmailAttempt"("invoiceId", "attemptedAt");

-- CreateIndex
CREATE INDEX "InvoiceEmailAttempt_invoiceId_status_attemptedAt_idx" ON "InvoiceEmailAttempt"("invoiceId", "status", "attemptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_pdfStoragePath_key" ON "Invoice"("pdfStoragePath");

-- AddForeignKey
ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "InvoiceLineItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceEmailAttempt" ADD CONSTRAINT "InvoiceEmailAttempt_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceEmailAttempt" ADD CONSTRAINT "InvoiceEmailAttempt_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
