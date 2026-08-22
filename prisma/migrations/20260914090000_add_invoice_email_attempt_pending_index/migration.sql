/*
  Invoice System Slice 4, PR 4a — the one schema gap Slice 1's own
  InvoiceEmailAttempt migration (20260912090000) explicitly deferred to
  Slice 4: a partial unique index enforcing "at most one PENDING attempt
  per invoice" (docs/invoicing-architecture.md §4.3/§9.2). This is the
  hard, database-enforced backstop against two concurrent active sends
  for the same invoice (double-click, two browser tabs, two different
  staff members racing) — a client-side disabled-button/rate-limit is a
  secondary UX control, never the safety guarantee.

  Deliberately NOT `@@unique([invoiceId, status])` in prisma/schema.prisma
  (see that model's own updated comment) — an ordinary unique constraint
  on (invoiceId, status) would forbid every legitimate historical
  non-PENDING row for the same invoice (multiple ACCEPTED/FAILED/UNKNOWN
  rows across retries/resends are all expected and allowed); only a
  genuinely partial index scoped to `status = 'PENDING'` expresses the
  actual invariant. This is exactly why the index is raw SQL here rather
  than expressed in the Prisma schema DSL: this project's own Prisma
  configuration has no partial-index syntax available (the identical
  reason NotificationDelivery's own would-be partial index was replaced
  with a plain composite index instead — see that model's own comment in
  prisma/schema.prisma).

  Purely additive: one new index on an existing table/column — no new
  model, enum, column, foreign key, or ordinary (non-partial) index; no
  ALTER TABLE; no data rewrite; no backfill of any kind. Old application
  code deployed against this schema sees no behavioral change at all,
  since no code path creates an InvoiceEmailAttempt row yet (Slice 4's own
  send path, PR 4b, is what will actually write PENDING rows for the
  first time).

  No explicit top-level BEGIN/COMMIT — matching every other migration in
  this repository (verified directly: no existing migration.sql file uses
  one). CREATE UNIQUE INDEX itself fails safely and loudly if unexpected
  duplicate PENDING rows already exist for the same invoiceId at the
  moment this migration runs (Postgres refuses to create a unique index
  over data that already violates it, surfacing as an ordinary migration
  failure rather than a silent partial application) — this repository's
  own preflight step (documented, not part of this SQL file) already
  confirms zero existing InvoiceEmailAttempt rows exist at all prior to
  Slice 4, so this failure mode is not expected to be reachable in
  practice, but the index's own construction still fails closed if it
  ever were.

  No external/staging/production database was touched applying this
  migration — it was only ever applied against this repository's local,
  ephemeral PGlite-backed test harness (test/support/local-postgres.ts)
  while authoring it, exactly like every other migration in this project.
*/

-- CreateIndex
CREATE UNIQUE INDEX "invoice_email_attempt_one_pending" ON "InvoiceEmailAttempt"("invoiceId") WHERE "status" = 'PENDING';
