import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration source-contract regression coverage for
 * 20260911090000_repair_invoice_organization_scope — a narrow test of the
 * migration.sql text itself, not a full-file snapshot (harmless
 * reformatting must never break this) and not a live-database replay
 * (this migration is already applied to the one shared test database by
 * the integration suite's own global setup before any test file runs —
 * see test/support/local-postgres.ts — so it cannot be re-applied against
 * deliberately corrupted data inside a normal test without temporarily
 * moving its own directory off disk, which would risk destabilizing every
 * other integration test file sharing that one database/migrations
 * directory). The migration file's own header comment documents the real,
 * by-hand reproduction this contract is standing in for: a fresh, isolated
 * PGlite instance, this migration applied against a deliberately seeded
 * inconsistent row, proving both that the guard fires and that Postgres/
 * Prisma Migrate roll back every statement in the file together.
 *
 * What this file proves instead: the migration's *source* contains the
 * guard/backfill/verify/ALTER statements in the correct order, with the
 * exact semantic checks the pre-backfill consistency guard must cover.
 * Every assertion below matches on a stable fragment of SQL, never a
 * full line or the file's exact formatting — reindenting or rewrapping a
 * comment must never break this.
 */

const migrationSql = readFileSync(
  join(
    __dirname,
    "../../prisma/migrations/20260911090000_repair_invoice_organization_scope/migration.sql",
  ),
  "utf-8",
);

/** Index of the first occurrence of `needle`, failing loudly (not -1) if absent. */
function indexOfOrThrow(haystack: string, needle: string): number {
  const index = haystack.indexOf(needle);
  if (index === -1) {
    throw new Error(`Expected migration.sql to contain: ${JSON.stringify(needle)}`);
  }
  return index;
}

describe("20260911090000_repair_invoice_organization_scope — migration contract", () => {
  it("contains no explicit BEGIN/COMMIT — Prisma Migrate already wraps this file in its own transaction (see the migration's own header comment for the by-hand reproduction proving this)", () => {
    // Matched as statement-starting tokens, not merely "somewhere in the
    // file" — the guard/verify DO blocks legitimately contain the word
    // "BEGIN" as PL/pgSQL block syntax (`DO $$ ... BEGIN ... END $$;`),
    // which must not be confused with a top-level transaction-control
    // BEGIN statement.
    expect(migrationSql).not.toMatch(/^\s*BEGIN;\s*$/m);
    expect(migrationSql).not.toMatch(/^\s*COMMIT;\s*$/m);
  });

  it("statement order: guard, then backfill UPDATE, then verify, then DROP/ALTER/ADD constraint", () => {
    const guardIndex = indexOfOrThrow(migrationSql, "DO $$");
    const updateIndex = indexOfOrThrow(migrationSql, 'UPDATE "Invoice" i');
    // The second "DO $$" is the post-backfill verify block.
    const verifyIndex = migrationSql.indexOf("DO $$", guardIndex + 1);
    const dropConstraintIndex = indexOfOrThrow(migrationSql, 'DROP CONSTRAINT "Invoice_organizationId_fkey"');
    const setNotNullIndex = indexOfOrThrow(migrationSql, 'ALTER COLUMN "organizationId" SET NOT NULL');
    const addConstraintIndex = indexOfOrThrow(migrationSql, 'ADD CONSTRAINT "Invoice_organizationId_fkey"');

    expect(verifyIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(updateIndex);
    expect(updateIndex).toBeLessThan(verifyIndex);
    expect(verifyIndex).toBeLessThan(dropConstraintIndex);
    expect(dropConstraintIndex).toBeLessThan(setNotNullIndex);
    expect(setNotNullIndex).toBeLessThan(addConstraintIndex);
  });

  describe("pre-backfill consistency guard — every required check is present", () => {
    // Extract just the first DO $$ ... $$ block (the guard), so a match
    // inside the verify block or a comment can't produce a false pass.
    const guardStart = migrationSql.indexOf("DO $$");
    const guardEnd = migrationSql.indexOf("END $$;", guardStart) + "END $$;".length;
    const guardBlock = migrationSql.slice(guardStart, guardEnd);

    it("joins both Project and Client", () => {
      expect(guardBlock).toContain('LEFT JOIN "Project" p ON p.id = i."projectId"');
      expect(guardBlock).toContain('LEFT JOIN "Client" c ON c.id = i."clientId"');
    });

    it("covers a missing Project and a missing Client", () => {
      expect(guardBlock).toContain("p.id IS NULL");
      expect(guardBlock).toContain("c.id IS NULL");
    });

    it("covers Project with no organizationId and Client with no organizationId", () => {
      expect(guardBlock).toContain('p."organizationId" IS NULL');
      expect(guardBlock).toContain('c."organizationId" IS NULL');
    });

    it("covers Invoice.clientId disagreeing with Invoice.project.clientId, using a null-safe comparison", () => {
      expect(guardBlock).toContain('i."clientId" IS DISTINCT FROM p."clientId"');
      expect(guardBlock).not.toContain('i."clientId" != p."clientId"');
      expect(guardBlock).not.toContain('i."clientId" <> p."clientId"');
    });

    it("covers Project.organizationId disagreeing with Client.organizationId, using a null-safe comparison", () => {
      expect(guardBlock).toContain('p."organizationId" IS DISTINCT FROM c."organizationId"');
      expect(guardBlock).not.toContain('p."organizationId" != c."organizationId"');
    });

    it("covers an existing non-null Invoice.organizationId disagreeing with Project.organizationId, using a null-safe comparison, and never overwrites it", () => {
      expect(guardBlock).toContain(
        'i."organizationId" IS NOT NULL AND i."organizationId" IS DISTINCT FROM p."organizationId"',
      );
      expect(guardBlock).not.toContain('i."organizationId" != p."organizationId"');
    });

    it("raises with a fixed, non-sensitive message containing only the count — never a row id or other row content", () => {
      expect(guardBlock).toMatch(/RAISE EXCEPTION '[^']*% invoice row\(s\)/);
      // The only "%"-style RAISE EXCEPTION substitution in the guard is the
      // count itself — no second substitution parameter (e.g. a row id)
      // is ever passed.
      const raiseLine = guardBlock.slice(guardBlock.indexOf("RAISE EXCEPTION"));
      const percentCount = (raiseLine.match(/%/g) ?? []).length;
      expect(percentCount).toBe(1);
    });
  });

  it("the backfill UPDATE only ever touches currently-null Invoice.organizationId rows, and copies from Project.organizationId", () => {
    const updateStart = indexOfOrThrow(migrationSql, 'UPDATE "Invoice" i');
    const updateEnd = migrationSql.indexOf(";", updateStart) + 1;
    const updateStatement = migrationSql.slice(updateStart, updateEnd);

    expect(updateStatement).toContain('SET "organizationId" = p."organizationId"');
    expect(updateStatement).toContain('FROM "Project" p');
    expect(updateStatement).toContain('WHERE p.id = i."projectId"');
    expect(updateStatement).toContain('AND i."organizationId" IS NULL');
  });

  it("verifies zero remaining NULLs before SET NOT NULL is ever reached", () => {
    const verifyStart = migrationSql.indexOf("DO $$", migrationSql.indexOf("DO $$") + 1);
    const verifyEnd = migrationSql.indexOf("END $$;", verifyStart) + "END $$;".length;
    const verifyBlock = migrationSql.slice(verifyStart, verifyEnd);

    expect(verifyBlock).toContain('SELECT COUNT(*) INTO remaining_null FROM "Invoice" WHERE "organizationId" IS NULL');
    expect(verifyBlock).toMatch(/RAISE EXCEPTION/);
    expect(verifyEnd).toBeLessThan(indexOfOrThrow(migrationSql, 'ALTER COLUMN "organizationId" SET NOT NULL'));
  });

  it("the foreign key is replaced as ON DELETE RESTRICT (not the original SetNull)", () => {
    const addConstraintStart = indexOfOrThrow(migrationSql, 'ADD CONSTRAINT "Invoice_organizationId_fkey"');
    const addConstraintStatement = migrationSql.slice(addConstraintStart, migrationSql.indexOf(";", addConstraintStart) + 1);
    expect(addConstraintStatement).toContain('FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT');
  });
});
