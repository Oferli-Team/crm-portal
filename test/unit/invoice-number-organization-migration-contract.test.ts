import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration source-contract regression coverage for
 * 20260916090000_invoice_number_unique_per_organization (Invoice System
 * Official Slice 5c) — a narrow, static test of the migration.sql text
 * itself (stable SQL fragments, never a full-file snapshot), matching the
 * precedent test/unit/invoice-slice1-migration-contract.test.ts and
 * test/unit/invoice-totals-not-null-migration-contract.test.ts already
 * established for this repo's other guarded migrations.
 *
 * Live, executed database behavior (guard-fires/no-partial-index/guard-
 * passes/rejected-afterward/cross-org-allowed) is proven separately in
 * test/integration/invoices/invoice-number-organization-migration-
 * contract.test.ts, using its own fully-isolated, disposable PGlite
 * instances — kept out of test/unit so unit runs never pay the cost of
 * starting a database, matching vitest.config.mts's own stated reason
 * for splitting unit and integration configs in the first place.
 */

const MIGRATION_DIR_NAME = "20260916090000_invoice_number_unique_per_organization";
const REAL_MIGRATION_DIR = join(__dirname, "../../prisma/migrations", MIGRATION_DIR_NAME);

const migrationSql = readFileSync(join(REAL_MIGRATION_DIR, "migration.sql"), "utf-8");
// Comments stripped once, up front — this migration's own header comment
// discusses the guard/statements in prose (including the literal
// substrings "DO $$" and "lower()"), which would otherwise corrupt any
// position- or pattern-based check run against the raw file text.
const sqlOnly = migrationSql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");

describe("20260916090000_invoice_number_unique_per_organization — migration contract (static)", () => {
  it("exactly one new migration directory exists for this change", () => {
    const migrationsRoot = join(__dirname, "../../prisma/migrations");
    const matches = readdirSync(migrationsRoot).filter((name) => name.includes("invoice_number_unique_per_organization"));
    expect(matches).toEqual([MIGRATION_DIR_NAME]);
  });

  it("contains no explicit BEGIN/COMMIT", () => {
    expect(sqlOnly).not.toMatch(/^\s*BEGIN;\s*$/m);
    expect(sqlOnly).not.toMatch(/^\s*COMMIT;\s*$/m);
  });

  it("contains no ALTER TABLE of any kind — only index operations and the hand-authored guard", () => {
    expect(sqlOnly).not.toMatch(/ALTER\s+TABLE/i);
  });

  it("performs no UPDATE/INSERT/DELETE/backfill/auto-rename of any kind — only verifies", () => {
    expect(sqlOnly).not.toMatch(/\bUPDATE\s+"Invoice"/);
    expect(sqlOnly).not.toMatch(/\bINSERT\s+INTO/i);
    expect(sqlOnly).not.toMatch(/\bDELETE\s+FROM/i);
    expect(sqlOnly).not.toMatch(/COALESCE/);
  });

  it("performs no rename and no DROP other than the one expected old index", () => {
    expect(sqlOnly).not.toMatch(/RENAME/i);
    const dropMatches = [...sqlOnly.matchAll(/DROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|TYPE)\s+"?([\w"]+)"?/gi)];
    expect(dropMatches).toHaveLength(1);
    expect(dropMatches[0][0]).toContain("Invoice_clientId_invoiceNumber_key");
  });

  it("creates no case-normalizing index or function — exact case-sensitive comparison is preserved", () => {
    expect(sqlOnly).not.toMatch(/LOWER\s*\(/i);
    expect(sqlOnly).not.toMatch(/CITEXT/i);
  });

  it("selects no raw row data anywhere — the guard is count-only", () => {
    expect(sqlOnly).not.toMatch(/SELECT\s+\*/i);
    expect(sqlOnly).not.toMatch(/SELECT\s+"invoiceNumber"/);
    expect(sqlOnly).not.toMatch(/SELECT\s+"id"/);
  });

  describe("pre-alter verification guard", () => {
    // Positions computed against the comment-stripped text — this
    // migration's own header comment contains the literal substring
    // "DO $$" in prose, which would otherwise match first.
    const guardStart = sqlOnly.indexOf("DO $$");
    const guardEnd = sqlOnly.indexOf("END $$;", guardStart) + "END $$;".length;
    const guardBlock = sqlOnly.slice(guardStart, guardEnd);

    it("exists and covers all three blocking classifications", () => {
      expect(guardStart).toBeGreaterThan(-1);
      expect(guardBlock).toMatch(/GROUP BY\s+"organizationId",\s*"invoiceNumber"\s+HAVING COUNT\(\*\) > 1/);
      expect(guardBlock).toContain(`TRIM("invoiceNumber") = ''`);
      expect(guardBlock).toMatch(/"organizationId"\s+IS DISTINCT FROM\s+p\."organizationId"/);
      expect(guardBlock).toMatch(/"organizationId"\s+IS DISTINCT FROM\s+c\."organizationId"/);
    });

    it("raises with a fixed, count-only message — never a row id, invoice number, or org/client value", () => {
      const raiseLine = guardBlock.slice(guardBlock.indexOf("RAISE EXCEPTION"));
      const percentCount = (raiseLine.match(/%/g) ?? []).length;
      expect(percentCount).toBe(3);
      expect(raiseLine).not.toMatch(/%[a-zA-Z]/); // no %s/%L-style value interpolation beyond plain %
    });

    it("does not include the informational case-insensitive or untrimmed-whitespace counts as blocking conditions", () => {
      expect(guardBlock).not.toMatch(/LOWER\s*\(/i);
      expect(guardBlock).not.toMatch(/<>\s*TRIM\(/);
    });
  });

  it("statement order: guard precedes CREATE UNIQUE INDEX, which precedes DROP INDEX", () => {
    const guardIndex = sqlOnly.indexOf("DO $$");
    const createIndex = sqlOnly.indexOf("CREATE UNIQUE INDEX");
    const dropIndex = sqlOnly.indexOf("DROP INDEX");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(-1);
    expect(dropIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(createIndex);
    expect(createIndex).toBeLessThan(dropIndex);
  });

  it("creates exactly the new organization-scoped index and drops exactly the old client-scoped index, by exact name and columns", () => {
    expect(sqlOnly).toContain(
      'CREATE UNIQUE INDEX "Invoice_organizationId_invoiceNumber_key" ON "Invoice"("organizationId", "invoiceNumber");',
    );
    expect(sqlOnly).toContain('DROP INDEX "Invoice_clientId_invoiceNumber_key";');
  });
});

describe("prisma/schema.prisma — Invoice uniqueness reflects the Slice 5c contract", () => {
  const schema = readFileSync(join(__dirname, "../../prisma/schema.prisma"), "utf-8");
  const invoiceModelStart = schema.indexOf("model Invoice {");
  const invoiceModelEnd = schema.indexOf("\n}", invoiceModelStart);
  const invoiceModel = schema.slice(invoiceModelStart, invoiceModelEnd);

  it("declares @@unique([organizationId, invoiceNumber])", () => {
    expect(invoiceModel).toMatch(/@@unique\(\[organizationId, invoiceNumber\]\)/);
  });

  it("no longer declares the old [clientId, invoiceNumber] tuple", () => {
    expect(invoiceModel).not.toMatch(/@@unique\(\[clientId, invoiceNumber\]\)/);
  });
});
