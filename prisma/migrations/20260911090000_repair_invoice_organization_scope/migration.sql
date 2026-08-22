/*
  Repairs the pre-existing defect where production Invoice create/update
  never wrote Invoice.organizationId, leaving it permanently NULL for every
  real (non-seeded) invoice. Three Analytics read paths
  (organization-metrics.ts, completion-metrics.ts, time-series.ts) query
  Invoice.organizationId directly and were silently undercounting as a
  result.

  This repository has no real customer history, so this repair is done as
  one atomic, self-verifying migration rather than a separate manually-run
  backfill script: guard against unresolvable/inconsistent data first,
  deterministically backfill only currently-null rows from
  Project.organizationId, verify, then apply the NOT NULL constraint and
  replace the foreign key with ON DELETE RESTRICT.

  Atomicity: this file deliberately contains NO explicit BEGIN/COMMIT.
  Prisma Migrate already wraps every migration.sql file's statements in
  its own database transaction when applying it via `prisma migrate
  deploy` — verified directly, twice, against this exact toolchain
  (Prisma 7.9.1, the PGlite-backed Postgres this repo's own integration
  harness uses — see test/support/local-postgres.ts): a deliberately
  seeded inconsistent row (Invoice.clientId disagreeing with its
  Project.clientId) made the guard below raise, `prisma migrate deploy`
  exited non-zero, and every statement in this file — including the
  earlier successful UPDATE, had there been one — was rolled back:
  Invoice.organizationId stayed nullable and the seeded row was
  untouched. Adding an explicit BEGIN/COMMIT was also tried against the
  same reproduction: it did NOT add any additional safety (the rollback
  already happened correctly either way) but it DID suppress this
  file's own RAISE EXCEPTION message — Postgres's nested-transaction
  handling replaced it with a generic, unhelpful "current transaction is
  aborted, commands ignored until end of transaction block" by the time
  the migrate engine's own error surfaced. An explicit BEGIN/COMMIT was
  therefore deliberately left out: it would make the failure mode worse
  for whoever has to read the error, not safer.
  test/unit/invoice-organization-migration-contract.test.ts asserts the
  guard/backfill/verify/ALTER contract this file must keep (order and
  semantic content, not a full-file snapshot); the atomicity finding
  itself was verified by hand against a real, isolated PGlite instance
  (a fresh instance, this migration only, a deliberately seeded
  inconsistent row) — not checked in as a permanent automated test, since
  doing so would require temporarily moving this migration's own
  directory on disk during a shared test run, which risks destabilizing
  every other integration test file sharing this repo's one global test
  database and migrations directory.

  Warnings:

  - Made the column `organizationId` on table `Invoice` required. This
    migration aborts loudly (RAISE EXCEPTION) instead of proceeding if any
    row cannot be safely resolved — it never guesses and never overwrites
    an existing non-null value that disagrees with its Project.

*/

-- Guard: abort before any write if any Invoice row cannot be safely
-- resolved. Proves, for every row:
--   Invoice.clientId == Invoice.project.clientId, and
--   Invoice.organizationId (when already non-null) == Invoice.project.organizationId == Invoice.client.organizationId
-- Specifically, aborts on:
--   - a missing Project relation (should be structurally impossible:
--     projectId is NOT NULL with an ON DELETE RESTRICT foreign key,
--     checked anyway as a defensive assertion);
--   - a missing Client relation (same defensive reasoning, clientId is
--     NOT NULL with an ON DELETE RESTRICT foreign key);
--   - a Project with no organizationId of its own;
--   - a Client with no organizationId of its own;
--   - Invoice.clientId disagreeing with Invoice.project.clientId — the two
--     FKs must name the same Client, or copying Project.organizationId
--     onto this Invoice would be scoping it through a Project that isn't
--     actually its own;
--   - Project.organizationId disagreeing with Client.organizationId — the
--     two independent paths to "which org" must agree before either can
--     be trusted as the source of truth;
--   - an existing non-null Invoice.organizationId that disagrees with
--     Project.organizationId.
-- Every comparison against a nullable column uses IS DISTINCT FROM, never
-- a plain != (which yields UNKNOWN, not TRUE, when either side is NULL,
-- and would silently fail to flag a real inconsistency involving a NULL).
-- Never guessed, never silently overwritten — matches
-- prisma/backfill-organizations.ts's own "report, never guess" precedent
-- for this exact column, applied here as a hard migration-time abort
-- since there is no real customer data to leave unresolved for later
-- manual review. The raised error contains only a count, never a row id
-- or any other row content.
DO $$
DECLARE
  unresolved_count integer;
BEGIN
  SELECT COUNT(*) INTO unresolved_count
  FROM "Invoice" i
  LEFT JOIN "Project" p ON p.id = i."projectId"
  LEFT JOIN "Client" c ON c.id = i."clientId"
  WHERE
    p.id IS NULL
    OR c.id IS NULL
    OR p."organizationId" IS NULL
    OR c."organizationId" IS NULL
    OR i."clientId" IS DISTINCT FROM p."clientId"
    OR p."organizationId" IS DISTINCT FROM c."organizationId"
    OR (i."organizationId" IS NOT NULL AND i."organizationId" IS DISTINCT FROM p."organizationId");

  IF unresolved_count > 0 THEN
    RAISE EXCEPTION 'Invoice.organizationId repair aborted: % invoice row(s) failed the pre-backfill consistency guard (missing Project/Client, missing organizationId on either, Invoice.clientId disagreeing with Project.clientId, Project/Client organizationId disagreeing, or an existing Invoice.organizationId disagreeing with Project.organizationId). Resolve these rows manually before re-running this migration.', unresolved_count;
  END IF;
END $$;

-- Deterministic backfill: copy Project.organizationId into every
-- currently-null Invoice.organizationId row only. A row with an existing
-- non-null value is never touched here — the guard above already proved
-- none of those disagree with their Project.
UPDATE "Invoice" i
SET "organizationId" = p."organizationId"
FROM "Project" p
WHERE p.id = i."projectId"
  AND i."organizationId" IS NULL;

-- Verify: every row must be non-null before proceeding to the NOT NULL
-- constraint below. Defensive — the guard above already proved every row
-- is resolvable, so this should be unreachable.
DO $$
DECLARE
  remaining_null integer;
BEGIN
  SELECT COUNT(*) INTO remaining_null FROM "Invoice" WHERE "organizationId" IS NULL;
  IF remaining_null > 0 THEN
    RAISE EXCEPTION 'Invoice.organizationId repair aborted: % invoice row(s) still NULL after backfill — this should be unreachable given the guard above.', remaining_null;
  END IF;
END $$;

-- DropForeignKey
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_organizationId_fkey";

-- AlterTable
ALTER TABLE "Invoice" ALTER COLUMN "organizationId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
