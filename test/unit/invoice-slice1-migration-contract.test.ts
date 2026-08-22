import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration source-contract regression coverage for
 * 20260912090000_add_invoice_system_slice1_foundation — a narrow test of
 * the migration.sql text itself (stable SQL fragments, never a full-file
 * snapshot; harmless reformatting must never break this), matching the
 * precedent test/unit/invoice-organization-migration-contract.test.ts
 * already established for this repo's other guarded/backfilling
 * migration. Not a live-database replay: this migration is already applied
 * to the one shared test database by the integration suite's own global
 * setup before any test file runs (test/support/local-postgres.ts).
 */

const migrationSql = readFileSync(
  join(__dirname, "../../prisma/migrations/20260912090000_add_invoice_system_slice1_foundation/migration.sql"),
  "utf-8",
);

function indexOfOrThrow(haystack: string, needle: string): number {
  const index = haystack.indexOf(needle);
  if (index === -1) {
    throw new Error(`Expected migration.sql to contain: ${JSON.stringify(needle)}`);
  }
  return index;
}

describe("20260912090000_add_invoice_system_slice1_foundation — migration contract", () => {
  it("contains no explicit BEGIN/COMMIT — follows the same choice already verified, once, for 20260911090000's exact reproduction (not a claim about every migration/environment)", () => {
    expect(migrationSql).not.toMatch(/^\s*BEGIN;\s*$/m);
    expect(migrationSql).not.toMatch(/^\s*COMMIT;\s*$/m);
  });

  describe("new enums/tables/columns exist", () => {
    it("creates the three Slice 1 enums", () => {
      expect(migrationSql).toContain(`CREATE TYPE "InvoiceDiscountType" AS ENUM ('NONE', 'PERCENTAGE', 'FIXED');`);
      expect(migrationSql).toContain(`CREATE TYPE "InvoiceTaxLabel" AS ENUM ('TAX', 'VAT', 'GST');`);
      expect(migrationSql).toContain(
        `CREATE TYPE "InvoiceEmailAttemptStatus" AS ENUM ('PENDING', 'ACCEPTED', 'FAILED', 'UNKNOWN');`,
      );
    });

    it("adds Client's optional billing-identity columns, all nullable", () => {
      const clientAlterStart = indexOfOrThrow(migrationSql, 'ALTER TABLE "Client" ADD COLUMN');
      const clientAlterEnd = migrationSql.indexOf(";", clientAlterStart) + 1;
      const clientAlter = migrationSql.slice(clientAlterStart, clientAlterEnd);

      for (const column of ["billingLegalName", "city", "country", "postalCode", "state", "streetAddress", "taxId"]) {
        expect(clientAlter).toContain(`"${column}" TEXT`);
        // None of these columns are ever declared NOT NULL.
        expect(clientAlter).not.toMatch(new RegExp(`"${column}" TEXT NOT NULL`));
      }
    });

    it("adds Invoice's Slice 1 columns with the transitional totals left nullable", () => {
      const invoiceAlterStart = indexOfOrThrow(migrationSql, 'ALTER TABLE "Invoice" ADD COLUMN');
      const invoiceAlterEnd = migrationSql.indexOf(
        "-- Deterministic legacy backfill",
        invoiceAlterStart,
      );
      const invoiceAlter = migrationSql.slice(invoiceAlterStart, invoiceAlterEnd);

      // Transitional totals: nullable, no default — never NOT NULL in Slice 1.
      for (const column of ["subtotal", "discountAmount", "taxAmount"]) {
        expect(invoiceAlter).toContain(`"${column}" DECIMAL(10,2)`);
        expect(invoiceAlter).not.toMatch(new RegExp(`"${column}" DECIMAL\\(10,2\\) NOT NULL`));
      }

      // Defaulted enum/int columns.
      expect(invoiceAlter).toContain(`"discountType" "InvoiceDiscountType" NOT NULL DEFAULT 'NONE'`);
      expect(invoiceAlter).toContain(`"taxLabel" "InvoiceTaxLabel" NOT NULL DEFAULT 'TAX'`);
      expect(invoiceAlter).toContain(`"documentVersion" INTEGER NOT NULL DEFAULT 1`);

      // Finalization/archival columns — all nullable, unwritten by Slice 1.
      for (const column of ["finalizedAt", "issuerSnapshot", "recipientSnapshot", "pdfStoragePath", "pdfGeneratedAt"]) {
        expect(invoiceAlter).toContain(`"${column}"`);
      }
      expect(invoiceAlter).not.toMatch(/"finalizedAt".*NOT NULL/);
      expect(invoiceAlter).not.toMatch(/"pdfStoragePath".*NOT NULL/);
    });

    it("creates InvoiceLineItem and InvoiceEmailAttempt tables", () => {
      expect(migrationSql).toContain('CREATE TABLE "InvoiceLineItem"');
      expect(migrationSql).toContain('CREATE TABLE "InvoiceEmailAttempt"');
    });
  });

  it("statement order: Invoice columns added, then backfill UPDATE, then post-backfill verify guard, then new tables", () => {
    const invoiceAlterIndex = indexOfOrThrow(migrationSql, 'ALTER TABLE "Invoice" ADD COLUMN');
    const updateIndex = indexOfOrThrow(migrationSql, 'UPDATE "Invoice"\nSET');
    const guardIndex = indexOfOrThrow(migrationSql, "DO $$");
    const lineItemTableIndex = indexOfOrThrow(migrationSql, 'CREATE TABLE "InvoiceLineItem"');

    expect(invoiceAlterIndex).toBeLessThan(updateIndex);
    expect(updateIndex).toBeLessThan(guardIndex);
    expect(guardIndex).toBeLessThan(lineItemTableIndex);
  });

  describe("deterministic legacy backfill", () => {
    const updateStart = indexOfOrThrow(migrationSql, 'UPDATE "Invoice"\nSET');
    const updateEnd = migrationSql.indexOf(";", updateStart) + 1;
    const updateStatement = migrationSql.slice(updateStart, updateEnd);

    it("copies amount into subtotal and zeroes discount/tax, only for currently-null values", () => {
      expect(updateStatement).toContain('"subtotal" = COALESCE("subtotal", "amount")');
      expect(updateStatement).toContain('"discountAmount" = COALESCE("discountAmount", 0)');
      expect(updateStatement).toContain('"taxAmount" = COALESCE("taxAmount", 0)');
    });

    it("scopes the UPDATE to rows with at least one null transitional total", () => {
      expect(updateStatement).toContain(
        'WHERE "subtotal" IS NULL OR "discountAmount" IS NULL OR "taxAmount" IS NULL',
      );
    });

    it("never writes amount, and never fabricates an InvoiceLineItem row", () => {
      expect(updateStatement).not.toMatch(/"amount"\s*=/);
      expect(migrationSql).not.toMatch(/INSERT INTO "InvoiceLineItem"/);
    });
  });

  describe("post-backfill verification guard", () => {
    const guardStart = migrationSql.indexOf("DO $$");
    const guardEnd = migrationSql.indexOf("END $$;", guardStart) + "END $$;".length;
    const guardBlock = migrationSql.slice(guardStart, guardEnd);

    it("runs after the backfill UPDATE", () => {
      const updateIndex = indexOfOrThrow(migrationSql, 'UPDATE "Invoice"\nSET');
      expect(guardStart).toBeGreaterThan(updateIndex);
    });

    it("checks subtotal = amount and discountAmount/taxAmount = 0 using null-safe comparisons", () => {
      expect(guardBlock).toContain('"subtotal" IS DISTINCT FROM "amount"');
      expect(guardBlock).toContain('"discountAmount" IS DISTINCT FROM 0');
      expect(guardBlock).toContain('"taxAmount" IS DISTINCT FROM 0');
      expect(guardBlock).not.toContain('"subtotal" != "amount"');
    });

    it("raises with a fixed, count-only message — never a row id or other row content", () => {
      expect(guardBlock).toMatch(/RAISE EXCEPTION '[^']*% invoice row\(s\)/);
      const raiseLine = guardBlock.slice(guardBlock.indexOf("RAISE EXCEPTION"));
      const percentCount = (raiseLine.match(/%/g) ?? []).length;
      expect(percentCount).toBe(1);
    });
  });

  it("applies no NOT NULL/contract-phase change to subtotal, discountAmount, or taxAmount", () => {
    expect(migrationSql).not.toMatch(/ALTER COLUMN "subtotal" SET NOT NULL/);
    expect(migrationSql).not.toMatch(/ALTER COLUMN "discountAmount" SET NOT NULL/);
    expect(migrationSql).not.toMatch(/ALTER COLUMN "taxAmount" SET NOT NULL/);
  });

  it("leaves the existing [clientId, invoiceNumber] invoice-number uniqueness constraint untouched", () => {
    // No DDL statement in this migration drops or recreates the existing
    // Invoice_clientId_invoiceNumber_key constraint (that contract change
    // is explicitly Slice 5's, §4.5/§12.5) — the only mention of
    // invoiceNumber anywhere in this file is inside a header comment
    // documenting that deferral, never a live SQL statement.
    expect(migrationSql).not.toContain("Invoice_clientId_invoiceNumber_key");
    expect(migrationSql).not.toMatch(/DROP\s+(INDEX|CONSTRAINT).*invoiceNumber/i);
    expect(migrationSql).not.toMatch(/CREATE\s+UNIQUE\s+INDEX.*invoiceNumber/i);
  });

  it("adds no partial unique index on InvoiceEmailAttempt (Slice 4 owns it)", () => {
    expect(migrationSql).not.toMatch(/WHERE\s+status\s*=\s*'PENDING'/);
  });

  it("performs no PDF Storage operation and adds pdfStoragePath as a plain unique column", () => {
    expect(migrationSql).toContain('CREATE UNIQUE INDEX "Invoice_pdfStoragePath_key" ON "Invoice"("pdfStoragePath");');
  });
});
