/*
  Invoice System Official Slice 5b — the deferred schema contract-phase
  migration for Invoice's three transitional calculated-total columns
  (docs/invoicing-architecture.md §4.1/§12 step 4). Slice 1
  (20260912090000_add_invoice_system_slice1_foundation) deliberately left
  `subtotal`/`discountAmount`/`taxAmount` nullable, with no database
  default, precisely so an old application version still running during
  that slice's own rolling deploy window could insert a row before the
  dual-write path existed everywhere. Every real write path
  (`invoices/new/actions.ts`, `invoices/[id]/edit/actions.ts`) has written
  all three from `calculateInvoiceTotals()`'s own always-non-null Decimal
  result since the moment Slice 1 shipped, and that deploy cycle has long
  since completed — this migration is the contract step every earlier
  slice explicitly deferred, never assumed to land atomically with any of
  them.

  This migration performs NO backfill and NO UPDATE of any kind — unlike
  `20260912090000`'s own guard (which followed a real backfill it had
  just performed), this repository's live application code is the only
  writer of these three columns, and every writer has always supplied a
  non-null value since Slice 1. The guard below exists only to *verify*
  that invariant against whatever real data actually exists at migration
  time — never to silently repair it. If any row is found to violate it,
  this migration aborts loudly rather than guessing at or coalescing a
  value: a hard, disclosed stop for a human to investigate, mirroring the
  exact "verify, never guess, never silently repair" discipline
  `20260911090000_repair_invoice_organization_scope` and
  `20260912090000_add_invoice_system_slice1_foundation` both already
  established as this repository's own precedent for a schema change with
  real data consequences if silently wrong. The raised message contains
  only a count, never a row id or any other row content.

  After the guard passes, all three columns are altered together in one
  statement to their final §4.1 contracted shape: NOT NULL, DEFAULT 0 —
  produced directly by this repository's own Prisma schema-diff generator
  (`prisma migrate diff --from-schema <current> --to-schema <target>
  --script`, run against the two schema states with no database
  connection of any kind) rather than hand-authored, so its exact
  identifier quoting/statement order/default representation is this
  toolchain's own, not a guess.

  This migration deliberately contains NO explicit top-level BEGIN/COMMIT
  — the same choice `20260911090000_repair_invoice_organization_scope`
  and `20260912090000_add_invoice_system_slice1_foundation` both already
  made and documented in their own header comments (Prisma Migrate already
  wraps a migration.sql file's own statements in its own transaction when
  applied via `prisma migrate deploy`, confirmed for this exact toolchain
  by `20260911090000`'s own one-time empirical reproduction; an explicit
  BEGIN/COMMIT was found there to only degrade the surfaced error message
  without adding any additional safety). This migration reuses that same
  conclusion rather than repeating the reproduction — not a general
  guarantee about every Prisma version, migration file, or deployment
  environment; a real deployment against any actual target database
  remains a separate, controlled operator step that should confirm this
  behavior in that environment rather than assume it.

  Explicitly NOT part of this migration (out of Slice 5b's own bounded
  scope, per docs/invoicing-architecture.md §12/§14):
  - No change to the existing `@@unique([clientId, invoiceNumber])`
    constraint or any other invoice-numbering work — that is Slice 5c's,
    explicitly, gated on its own real-data collision preflight
    (§4.5/§12.5).
  - No Portal visibility, email, PDF, archive, reconciliation, Activity,
    Notification, or Attachment change of any kind.
  - No DROP of any table, column, index, enum, relation, or constraint;
    no rename of any kind.
  - No external/staging/production database was touched applying this
    migration — it was only ever applied against this repository's
    local, ephemeral PGlite-backed test harness
    (test/support/local-postgres.ts) while authoring it, and separately,
    once, by hand, against a disposable, isolated PGlite instance (never
    the shared global test database) to directly observe both the guard
    firing and the guard passing before this file was ever added to
    version control.
*/

-- Pre-alter verification guard: every currently-existing Invoice row
-- must already have a non-null subtotal, discountAmount, and taxAmount
-- before the NOT NULL contract below can safely apply. Given every real
-- write path has supplied all three since Slice 1, this should be
-- unreachable in practice — it exists anyway as the same defensive,
-- self-verifying check this repository's own precedent migrations
-- already established. Never coalesces, never guesses, never repairs —
-- only verifies, then aborts loudly if the invariant does not hold.
DO $$
DECLARE
  null_total_count integer;
BEGIN
  SELECT COUNT(*) INTO null_total_count
  FROM "Invoice"
  WHERE "subtotal" IS NULL OR "discountAmount" IS NULL OR "taxAmount" IS NULL;

  IF null_total_count > 0 THEN
    RAISE EXCEPTION 'Invoice Slice 5b NOT NULL contract aborted: % invoice row(s) still have a NULL subtotal, discountAmount, or taxAmount.', null_total_count;
  END IF;
END $$;

-- AlterTable
ALTER TABLE "Invoice" ALTER COLUMN "subtotal" SET NOT NULL,
ALTER COLUMN "subtotal" SET DEFAULT 0,
ALTER COLUMN "discountAmount" SET NOT NULL,
ALTER COLUMN "discountAmount" SET DEFAULT 0,
ALTER COLUMN "taxAmount" SET NOT NULL,
ALTER COLUMN "taxAmount" SET DEFAULT 0;
