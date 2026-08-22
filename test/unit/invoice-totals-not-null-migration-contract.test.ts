import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration source-contract regression coverage for
 * 20260915090000_add_invoice_totals_not_null_contract — a narrow test of
 * the migration.sql text itself (stable SQL fragments, never a full-file
 * snapshot; harmless reformatting must never break this), matching the
 * precedent test/unit/invoice-slice1-migration-contract.test.ts and
 * test/unit/invoice-organization-migration-contract.test.ts already
 * established for this repo's other guarded migrations. Not a live-
 * database replay of the guard-fires/guard-passes behavior itself — that
 * was verified once, by hand, against a disposable, isolated PGlite
 * instance while authoring this migration (see the migration file's own
 * header comment), the same "not checked in as a permanent automated
 * test" precedent 20260911090000_repair_invoice_organization_scope's own
 * atomicity finding already established, since a real re-migration replay
 * would require moving this migration's own directory on disk during a
 * shared test run and risk destabilizing every other integration test
 * sharing this repo's one global test database. This migration IS already
 * applied to that shared test database by the integration suite's own
 * global setup before any test file runs (test/support/local-postgres.ts).
 */

const migrationSql = readFileSync(
  join(__dirname, "../../prisma/migrations/20260915090000_add_invoice_totals_not_null_contract/migration.sql"),
  "utf-8",
);

describe("20260915090000_add_invoice_totals_not_null_contract — migration contract", () => {
  it("contains no explicit BEGIN/COMMIT — follows the same choice already verified for this exact toolchain by 20260911090000's own reproduction", () => {
    expect(migrationSql).not.toMatch(/^\s*BEGIN;\s*$/m);
    expect(migrationSql).not.toMatch(/^\s*COMMIT;\s*$/m);
  });

  describe("pre-alter verification guard", () => {
    const guardStart = migrationSql.indexOf("DO $$");
    const guardEnd = migrationSql.indexOf("END $$;", guardStart) + "END $$;".length;
    const guardBlock = migrationSql.slice(guardStart, guardEnd);

    it("exists and covers subtotal, discountAmount, and taxAmount", () => {
      expect(guardStart).toBeGreaterThan(-1);
      expect(guardBlock).toContain('"subtotal" IS NULL');
      expect(guardBlock).toContain('"discountAmount" IS NULL');
      expect(guardBlock).toContain('"taxAmount" IS NULL');
    });

    it("raises with a fixed, count-only message — never a row id or other row content", () => {
      expect(guardBlock).toMatch(/RAISE EXCEPTION '[^']*% invoice row\(s\)/);
      const raiseLine = guardBlock.slice(guardBlock.indexOf("RAISE EXCEPTION"));
      const percentCount = (raiseLine.match(/%/g) ?? []).length;
      expect(percentCount).toBe(1);
    });

    it("performs no UPDATE/backfill of any kind — this migration only verifies, never repairs", () => {
      expect(migrationSql).not.toMatch(/UPDATE\s+"Invoice"/);
      expect(migrationSql).not.toMatch(/COALESCE/);
    });
  });

  it("statement order: the guard runs before every ALTER COLUMN on subtotal, discountAmount, or taxAmount", () => {
    const guardIndex = migrationSql.indexOf("DO $$");
    const alterIndex = migrationSql.indexOf('ALTER TABLE "Invoice" ALTER COLUMN');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(alterIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(alterIndex);

    for (const column of ["subtotal", "discountAmount", "taxAmount"]) {
      const columnAlterIndex = migrationSql.indexOf(`ALTER COLUMN "${column}"`);
      expect(columnAlterIndex).toBeGreaterThan(guardIndex);
    }
  });

  describe("the contract-phase ALTER itself", () => {
    const alterStart = migrationSql.indexOf('ALTER TABLE "Invoice" ALTER COLUMN');
    const alterStatement = migrationSql.slice(alterStart);

    it("sets all three columns NOT NULL", () => {
      for (const column of ["subtotal", "discountAmount", "taxAmount"]) {
        expect(alterStatement).toContain(`ALTER COLUMN "${column}" SET NOT NULL`);
      }
    });

    it("sets all three columns to DEFAULT 0", () => {
      for (const column of ["subtotal", "discountAmount", "taxAmount"]) {
        expect(alterStatement).toContain(`ALTER COLUMN "${column}" SET DEFAULT 0`);
      }
    });

    it("touches no other column of Invoice, and no other table", () => {
      expect(alterStatement).not.toMatch(/ALTER COLUMN "(?!subtotal|discountAmount|taxAmount)/);
      expect(migrationSql).not.toMatch(/ALTER TABLE "(?!Invoice")/);
    });
  });

  it("performs no DROP of any table, column, index, enum, relation, or constraint, and no rename of any kind", () => {
    // Comments stripped first — this migration's own header comment
    // discusses, in prose, what it does NOT do (including the word
    // "rename"), which a bare substring/regex check against the raw file
    // would otherwise wrongly flag.
    const sqlOnly = migrationSql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
    expect(sqlOnly).not.toMatch(/DROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|TYPE)/i);
    expect(sqlOnly).not.toMatch(/RENAME/i);
  });

  it("makes no invoice-number uniqueness change — that remains Slice 5c's own bounded scope", () => {
    expect(migrationSql).not.toContain("Invoice_clientId_invoiceNumber_key");
    expect(migrationSql).not.toMatch(/CREATE\s+UNIQUE\s+INDEX.*invoiceNumber/i);
    expect(migrationSql).not.toMatch(/DROP\s+(INDEX|CONSTRAINT).*invoiceNumber/i);
  });

  it("creates no enum, table, or new column of any kind", () => {
    expect(migrationSql).not.toMatch(/CREATE\s+(TYPE|TABLE)/i);
    expect(migrationSql).not.toMatch(/ADD\s+COLUMN/i);
  });
});

describe("prisma/schema.prisma — Invoice totals reflect the finalized Slice 5b contract", () => {
  const schema = readFileSync(join(__dirname, "../../prisma/schema.prisma"), "utf-8");
  const invoiceModelStart = schema.indexOf("model Invoice {");
  const invoiceModelEnd = schema.indexOf("\n}", invoiceModelStart);
  const invoiceModel = schema.slice(invoiceModelStart, invoiceModelEnd);

  it("subtotal, discountAmount, and taxAmount are all non-null Decimal with @default(0)", () => {
    for (const column of ["subtotal", "discountAmount", "taxAmount"]) {
      const fieldMatch = invoiceModel.match(new RegExp(`\\n\\s*${column}\\s+([^\\n]*)`));
      expect(fieldMatch).not.toBeNull();
      const fieldLine = fieldMatch![1];
      expect(fieldLine).toMatch(/^Decimal\s/);
      expect(fieldLine).not.toContain("Decimal?");
      expect(fieldLine).toContain("@default(0)");
      expect(fieldLine).toContain("@db.Decimal(10, 2)");
    }
  });
});
