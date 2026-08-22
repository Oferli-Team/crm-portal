import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration source-contract regression coverage for
 * 20260913090000_add_invoice_pdf_archive_ledger — a narrow test of the
 * migration.sql text itself (stable SQL fragments, never a full-file
 * snapshot), matching the precedent
 * test/unit/invoice-slice1-migration-contract.test.ts already established.
 * Not a live-database replay: this migration is already applied to the
 * one shared test database by the integration suite's own global setup
 * before any test file runs (test/support/local-postgres.ts).
 */

const migrationSql = readFileSync(
  join(__dirname, "../../prisma/migrations/20260913090000_add_invoice_pdf_archive_ledger/migration.sql"),
  "utf-8",
);

describe("20260913090000_add_invoice_pdf_archive_ledger — migration contract", () => {
  it("creates the InvoicePdfArchiveObjectStatus enum with all four values, in order", () => {
    expect(migrationSql).toContain(
      `CREATE TYPE "InvoicePdfArchiveObjectStatus" AS ENUM ('PENDING_UPLOAD', 'REFERENCED', 'CLEANUP_PENDING', 'CLEANED');`,
    );
  });

  it("creates the InvoicePdfArchiveObject table", () => {
    expect(migrationSql).toContain('CREATE TABLE "InvoicePdfArchiveObject"');
  });

  describe("column shape", () => {
    const tableStart = migrationSql.indexOf('CREATE TABLE "InvoicePdfArchiveObject"');
    const tableEnd = migrationSql.indexOf(");", tableStart) + 2;
    const tableBody = migrationSql.slice(tableStart, tableEnd);

    it("id is a UUID primary key, not a default-generated one (the application always supplies it explicitly, matching the archiveId)", () => {
      expect(tableBody).toContain('"id" UUID NOT NULL');
      expect(tableBody).not.toMatch(/"id" UUID NOT NULL DEFAULT/);
      expect(tableBody).toContain('CONSTRAINT "InvoicePdfArchiveObject_pkey" PRIMARY KEY ("id")');
    });

    it("organizationId is required", () => {
      expect(tableBody).toContain('"organizationId" UUID NOT NULL');
    });

    it("invoiceId is nullable (SetNull-safe against a concurrently-deleted DRAFT)", () => {
      expect(tableBody).toContain('"invoiceId" UUID,');
      expect(tableBody).not.toMatch(/"invoiceId" UUID NOT NULL/);
    });

    it("documentVersion is a required integer", () => {
      expect(tableBody).toContain('"documentVersion" INTEGER NOT NULL');
    });

    it("storagePath is a required text column (uniqueness is a separate index, checked below)", () => {
      expect(tableBody).toContain('"storagePath" TEXT NOT NULL');
    });

    it("status defaults to PENDING_UPLOAD", () => {
      expect(tableBody).toContain(`"status" "InvoicePdfArchiveObjectStatus" NOT NULL DEFAULT 'PENDING_UPLOAD'`);
    });

    it("referencedAt/cleanedAt/cleanupLockedAt are all nullable timestamps", () => {
      for (const column of ["referencedAt", "cleanedAt", "cleanupLockedAt"]) {
        expect(tableBody).toContain(`"${column}" TIMESTAMP(3)`);
        expect(tableBody).not.toMatch(new RegExp(`"${column}" TIMESTAMP\\(3\\) NOT NULL`));
      }
    });

    it("cleanupClaimToken is a nullable UUID", () => {
      expect(tableBody).toContain('"cleanupClaimToken" UUID,');
    });

    it("cleanupAttemptCount defaults to 0", () => {
      expect(tableBody).toContain('"cleanupAttemptCount" INTEGER NOT NULL DEFAULT 0');
    });

    it("lastCleanupFailureCategory is a nullable text column", () => {
      expect(tableBody).toContain('"lastCleanupFailureCategory" TEXT');
      expect(tableBody).not.toMatch(/"lastCleanupFailureCategory" TEXT NOT NULL/);
    });

    it("createdAt/updatedAt exist with the same shape every other model in this schema uses", () => {
      expect(tableBody).toContain('"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP');
      expect(tableBody).toContain('"updatedAt" TIMESTAMP(3) NOT NULL');
    });
  });

  describe("indexes/constraints", () => {
    it("storagePath is unique", () => {
      expect(migrationSql).toContain(
        'CREATE UNIQUE INDEX "InvoicePdfArchiveObject_storagePath_key" ON "InvoicePdfArchiveObject"("storagePath");',
      );
    });

    it("organizationId is indexed", () => {
      expect(migrationSql).toContain(
        'CREATE INDEX "InvoicePdfArchiveObject_organizationId_idx" ON "InvoicePdfArchiveObject"("organizationId");',
      );
    });

    it("invoiceId is indexed", () => {
      expect(migrationSql).toContain(
        'CREATE INDEX "InvoicePdfArchiveObject_invoiceId_idx" ON "InvoicePdfArchiveObject"("invoiceId");',
      );
    });

    it("(status, createdAt) is indexed", () => {
      expect(migrationSql).toContain(
        'CREATE INDEX "InvoicePdfArchiveObject_status_createdAt_idx" ON "InvoicePdfArchiveObject"("status", "createdAt");',
      );
    });

    it("(status, cleanupLockedAt) is indexed", () => {
      expect(migrationSql).toContain(
        'CREATE INDEX "InvoicePdfArchiveObject_status_cleanupLockedAt_idx" ON "InvoicePdfArchiveObject"("status", "cleanupLockedAt");',
      );
    });
  });

  describe("foreign keys", () => {
    it("organizationId restricts Organization delete — the durable ledger must never be silently erased by deleting its Organization", () => {
      expect(migrationSql).toContain(
        'ALTER TABLE "InvoicePdfArchiveObject" ADD CONSTRAINT "InvoicePdfArchiveObject_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;',
      );
      expect(migrationSql).not.toMatch(
        /InvoicePdfArchiveObject_organizationId_fkey.*ON DELETE CASCADE/,
      );
    });

    it("invoiceId sets null on Invoice delete (never cascades — the ledger must outlive a deleted DRAFT)", () => {
      expect(migrationSql).toContain(
        'ALTER TABLE "InvoicePdfArchiveObject" ADD CONSTRAINT "InvoicePdfArchiveObject_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
      );
    });
  });

  it("touches no existing table/column — purely additive (no ALTER TABLE on any pre-existing table)", () => {
    expect(migrationSql).not.toMatch(/ALTER TABLE "Invoice" /);
    expect(migrationSql).not.toMatch(/ALTER TABLE "Organization" /);
    expect(migrationSql).not.toContain("DROP ");
  });
});
