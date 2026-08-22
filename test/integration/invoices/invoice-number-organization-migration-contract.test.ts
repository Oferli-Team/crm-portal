import { rename, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "@/generated/prisma/client";

/**
 * Invoice System Official Slice 5c — live database behavior coverage for
 * 20260916090000_invoice_number_unique_per_organization's own guard/
 * ordering contract. Static SQL-text assertions live in
 * test/unit/invoice-number-organization-migration-contract.test.ts;
 * this file proves the migration's real, executed behavior instead
 * (guard-fires/no-partial-index/guard-passes/rejected-afterward/cross-
 * org-allowed), with RED→GREEN evidence, as this implementation task
 * explicitly requires.
 *
 * Deliberately does NOT use this suite's own shared harness
 * (test/support/local-postgres.ts, port 55432, started once by
 * test/integration/global-setup.ts before any test file body runs) —
 * every test below starts its own fresh, disposable, fully-isolated
 * PGlite instance on its own dedicated port instead. This is what makes
 * it safe to temporarily move `prisma/migrations/20260916090000_.../`
 * aside on disk (required so `prisma migrate deploy` can apply every
 * *other* migration first, to reach the "just before Slice 5c" state):
 * the shared harness has already finished applying every migration to
 * its own database before this file's body ever runs, and nothing else
 * in this repository re-reads the `prisma/migrations` directory listing
 * after that point — so moving this one directory aside for the
 * duration of a single, sequential `it()` body (always restored in a
 * `finally`, and again in `afterEach` as a backstop) cannot affect the
 * shared harness or any other test file. This is the same "verify,
 * don't destabilize the shared database" concern
 * `20260911090000_repair_invoice_organization_scope`'s own header
 * comment first raised, resolved here by isolation rather than by
 * leaving the behavior unverified.
 *
 * The moved-aside directory must live OUTSIDE `prisma/migrations`
 * entirely, not merely under a different name inside it — `prisma
 * migrate deploy` recognizes and applies every timestamp-prefixed
 * subdirectory it finds there regardless of the exact suffix, so a
 * same-parent rename does not exclude it (confirmed directly: an
 * earlier version of this file renamed it in place and Prisma applied
 * it anyway, defeating the whole "pre-Slice-5c" setup).
 */

const MIGRATION_DIR_NAME = "20260916090000_invoice_number_unique_per_organization";
const REAL_MIGRATION_DIR = join(__dirname, "../../../prisma/migrations", MIGRATION_DIR_NAME);
const MOVED_ASIDE_DIR = join(tmpdir(), `${MIGRATION_DIR_NAME}_TEMP_MOVED_FOR_TEST`);
const REPO_ROOT = join(__dirname, "../../..");

const migrationSql = readFileSync(join(REAL_MIGRATION_DIR, "migration.sql"), "utf-8");

const execFileAsync = promisify(execFile);

let activeCleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (activeCleanup) {
    await activeCleanup();
    activeCleanup = undefined;
  }
  await rm(MOVED_ASIDE_DIR, { recursive: true, force: true });
});

async function waitForSocketReady(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const client = new pg.Client({ host: "127.0.0.1", port, database: "postgres", user: "postgres" });
    try {
      await client.connect();
      await client.end();
      return;
    } catch {
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`isolated PGlite socket server never became reachable on port ${port}`);
}

async function startIsolatedDatabase(port: number): Promise<{ databaseUrl: string; pglite: PGlite; socketServer: PGLiteSocketServer }> {
  const pglite = new PGlite();
  const socketServer = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port, maxConnections: 5 });
  await socketServer.start();
  await waitForSocketReady(port);
  await pglite.query("CREATE ROLE anon NOLOGIN");
  await pglite.query("CREATE ROLE authenticated NOLOGIN");
  const databaseUrl = `postgresql://postgres@127.0.0.1:${port}/postgres`;
  return { databaseUrl, pglite, socketServer };
}

/** Applies every migration except this one (moves this migration's real directory aside for the duration of the deploy call only). */
async function deployAllMigrationsExceptThisOne(databaseUrl: string): Promise<void> {
  await rename(REAL_MIGRATION_DIR, MOVED_ASIDE_DIR);
  try {
    await execFileAsync("npx", ["prisma", "migrate", "deploy"], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl },
    });
  } finally {
    await rename(MOVED_ASIDE_DIR, REAL_MIGRATION_DIR);
  }
}

async function seedMinimalOrgClientProject(
  rawClient: pg.Client,
  ids: { orgId: string; userId: string; clientId: string; projectId: string; orgSlug: string; userEmail: string },
): Promise<void> {
  await rawClient.query(
    `INSERT INTO "Organization" (id, name, slug, "createdAt", "updatedAt") VALUES ($1, 'Probe Org', $2, now(), now())`,
    [ids.orgId, ids.orgSlug],
  );
  await rawClient.query(
    `INSERT INTO "User" (id, email, name, "createdAt", "updatedAt") VALUES ($1, $2, 'Probe User', now(), now())`,
    [ids.userId, ids.userEmail],
  );
  await rawClient.query(
    `INSERT INTO "Client" (id, name, "userId", "organizationId", "createdAt", "updatedAt") VALUES ($1, 'Probe Client', $2, $3, now(), now())`,
    [ids.clientId, ids.userId, ids.orgId],
  );
  await rawClient.query(
    `INSERT INTO "Project" (id, name, "clientId", "organizationId", "ownerId", status, "createdAt", "updatedAt") VALUES ($1, 'Probe Project', $2, $3, $4, 'IN_PROGRESS', now(), now())`,
    [ids.projectId, ids.clientId, ids.orgId, ids.userId],
  );
}

describe("20260916090000_invoice_number_unique_per_organization — live database behavior (isolated, disposable PGlite instances)", () => {
  it("RED: aborts atomically and leaves no partial index change when two Invoice rows share (organizationId, invoiceNumber)", async () => {
    const port = 55611;
    const { databaseUrl, pglite, socketServer } = await startIsolatedDatabase(port);
    activeCleanup = async () => {
      await socketServer.stop();
      await pglite.close();
    };

    await deployAllMigrationsExceptThisOne(databaseUrl);

    const rawClient = new pg.Client({ connectionString: databaseUrl });
    await rawClient.connect();
    const orgId = "aaaaaaaa-0000-0000-0000-000000000001";
    await seedMinimalOrgClientProject(rawClient, {
      orgId,
      userId: "aaaaaaaa-0000-0000-0000-000000000002",
      clientId: "aaaaaaaa-0000-0000-0000-000000000003",
      projectId: "aaaaaaaa-0000-0000-0000-000000000004",
      orgSlug: "probe-org-dup",
      userEmail: "probe-dup@example.com",
    });
    // A second Client + Project within the SAME organization — the old
    // client-scoped constraint must NOT reject this pair (they are
    // different clients), only the new organization-scoped guard should.
    await rawClient.query(
      `INSERT INTO "Client" (id, name, "userId", "organizationId", "createdAt", "updatedAt") VALUES ('aaaaaaaa-0000-0000-0000-000000000007', 'Probe Client 2', 'aaaaaaaa-0000-0000-0000-000000000002', $1, now(), now())`,
      [orgId],
    );
    await rawClient.query(
      `INSERT INTO "Project" (id, name, "clientId", "organizationId", "ownerId", status, "createdAt", "updatedAt") VALUES ('aaaaaaaa-0000-0000-0000-000000000008', 'Probe Project 2', 'aaaaaaaa-0000-0000-0000-000000000007', $1, 'aaaaaaaa-0000-0000-0000-000000000002', 'IN_PROGRESS', now(), now())`,
      [orgId],
    );
    await rawClient.query(
      `INSERT INTO "Invoice" (id, "invoiceNumber", status, amount, "issueDate", "clientId", "projectId", "organizationId", "createdAt", "updatedAt")
       VALUES ('aaaaaaaa-0000-0000-0000-000000000005', 'DUP-1', 'DRAFT', 10.00, now(), 'aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000004', '${orgId}', now(), now())`,
    );
    await rawClient.query(
      `INSERT INTO "Invoice" (id, "invoiceNumber", status, amount, "issueDate", "clientId", "projectId", "organizationId", "createdAt", "updatedAt")
       VALUES ('aaaaaaaa-0000-0000-0000-000000000006', 'DUP-1', 'DRAFT', 20.00, now(), 'aaaaaaaa-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000008', '${orgId}', now(), now())`,
    );

    await expect(rawClient.query(migrationSql)).rejects.toThrow(/organization-wide invoiceNumber uniqueness contract aborted/);

    const indexes = await rawClient.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'Invoice' AND indexname LIKE '%invoiceNumber%'`,
    );
    const names = indexes.rows.map((r) => r.indexname);
    expect(names).toContain("Invoice_clientId_invoiceNumber_key");
    expect(names).not.toContain("Invoice_organizationId_invoiceNumber_key");

    await rawClient.end();
  }, 30_000);

  it("RED: aborts on a blank/whitespace-only invoiceNumber", async () => {
    const port = 55612;
    const { databaseUrl, pglite, socketServer } = await startIsolatedDatabase(port);
    activeCleanup = async () => {
      await socketServer.stop();
      await pglite.close();
    };

    await deployAllMigrationsExceptThisOne(databaseUrl);

    const rawClient = new pg.Client({ connectionString: databaseUrl });
    await rawClient.connect();
    const orgId = "bbbbbbbb-0000-0000-0000-000000000001";
    await seedMinimalOrgClientProject(rawClient, {
      orgId,
      userId: "bbbbbbbb-0000-0000-0000-000000000002",
      clientId: "bbbbbbbb-0000-0000-0000-000000000003",
      projectId: "bbbbbbbb-0000-0000-0000-000000000004",
      orgSlug: "probe-org-blank",
      userEmail: "probe-blank@example.com",
    });
    await rawClient.query(
      `INSERT INTO "Invoice" (id, "invoiceNumber", status, amount, "issueDate", "clientId", "projectId", "organizationId", "createdAt", "updatedAt")
       VALUES ('bbbbbbbb-0000-0000-0000-000000000005', '   ', 'DRAFT', 10.00, now(), 'bbbbbbbb-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000004', '${orgId}', now(), now())`,
    );

    await expect(rawClient.query(migrationSql)).rejects.toThrow(/organization-wide invoiceNumber uniqueness contract aborted/);

    await rawClient.end();
  }, 30_000);

  it("RED: aborts on Invoice.organizationId disagreeing with its Project/Client organizationId", async () => {
    const port = 55613;
    const { databaseUrl, pglite, socketServer } = await startIsolatedDatabase(port);
    activeCleanup = async () => {
      await socketServer.stop();
      await pglite.close();
    };

    await deployAllMigrationsExceptThisOne(databaseUrl);

    const rawClient = new pg.Client({ connectionString: databaseUrl });
    await rawClient.connect();
    const orgId = "cccccccc-0000-0000-0000-000000000001";
    const otherOrgId = "cccccccc-0000-0000-0000-000000000009";
    await seedMinimalOrgClientProject(rawClient, {
      orgId,
      userId: "cccccccc-0000-0000-0000-000000000002",
      clientId: "cccccccc-0000-0000-0000-000000000003",
      projectId: "cccccccc-0000-0000-0000-000000000004",
      orgSlug: "probe-org-inconsistent",
      userEmail: "probe-inconsistent@example.com",
    });
    await rawClient.query(
      `INSERT INTO "Organization" (id, name, slug, "createdAt", "updatedAt") VALUES ($1, 'Other Org', 'probe-other-org', now(), now())`,
      [otherOrgId],
    );
    // Directly constructs the drift this repository's own two application
    // writers would never produce — proving the guard catches it anyway,
    // since nothing in the schema forbids it at the database level (see
    // this migration's own header comment on this exact residual risk).
    await rawClient.query(
      `INSERT INTO "Invoice" (id, "invoiceNumber", status, amount, "issueDate", "clientId", "projectId", "organizationId", "createdAt", "updatedAt")
       VALUES ('cccccccc-0000-0000-0000-000000000005', 'INCONSISTENT-1', 'DRAFT', 10.00, now(), 'cccccccc-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000004', $1, now(), now())`,
      [otherOrgId],
    );

    await expect(rawClient.query(migrationSql)).rejects.toThrow(/organization-wide invoiceNumber uniqueness contract aborted/);

    await rawClient.end();
  }, 30_000);

  it("GREEN: clean data migrates successfully; same-org duplicate rejected afterward; cross-org reuse remains allowed", async () => {
    const port = 55614;
    const { databaseUrl, pglite, socketServer } = await startIsolatedDatabase(port);
    activeCleanup = async () => {
      await socketServer.stop();
      await pglite.close();
    };

    await deployAllMigrationsExceptThisOne(databaseUrl);

    const rawClient = new pg.Client({ connectionString: databaseUrl });
    await rawClient.connect();
    const orgAId = "dddddddd-0000-0000-0000-000000000001";
    const orgBId = "dddddddd-0000-0000-0000-000000000009";
    await seedMinimalOrgClientProject(rawClient, {
      orgId: orgAId,
      userId: "dddddddd-0000-0000-0000-000000000002",
      clientId: "dddddddd-0000-0000-0000-000000000003",
      projectId: "dddddddd-0000-0000-0000-000000000004",
      orgSlug: "probe-org-a-clean",
      userEmail: "probe-a-clean@example.com",
    });
    await rawClient.query(
      `INSERT INTO "Invoice" (id, "invoiceNumber", status, amount, "issueDate", "clientId", "projectId", "organizationId", "createdAt", "updatedAt")
       VALUES ('dddddddd-0000-0000-0000-000000000005', 'CLEAN-1', 'DRAFT', 10.00, now(), 'dddddddd-0000-0000-0000-000000000003', 'dddddddd-0000-0000-0000-000000000004', $1, now(), now())`,
      [orgAId],
    );

    // GREEN: no data violates the guard, migration succeeds.
    await expect(rawClient.query(migrationSql)).resolves.toBeDefined();

    const indexes = await rawClient.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'Invoice' AND indexname LIKE '%invoiceNumber%'`,
    );
    const names = indexes.rows.map((r) => r.indexname);
    expect(names).toContain("Invoice_organizationId_invoiceNumber_key");
    expect(names).not.toContain("Invoice_clientId_invoiceNumber_key");

    // Same organization, same number: now rejected by the database itself.
    await expect(
      rawClient.query(
        `INSERT INTO "Invoice" (id, "invoiceNumber", status, amount, "issueDate", "clientId", "projectId", "organizationId", "createdAt", "updatedAt")
         VALUES ('dddddddd-0000-0000-0000-000000000006', 'CLEAN-1', 'DRAFT', 20.00, now(), 'dddddddd-0000-0000-0000-000000000003', 'dddddddd-0000-0000-0000-000000000004', $1, now(), now())`,
        [orgAId],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint "Invoice_organizationId_invoiceNumber_key"/);

    // Different organization, same number: remains allowed.
    await rawClient.query(
      `INSERT INTO "Organization" (id, name, slug, "createdAt", "updatedAt") VALUES ($1, 'Org B', 'probe-org-b-clean', now(), now())`,
      [orgBId],
    );
    await rawClient.query(
      `INSERT INTO "User" (id, email, name, "createdAt", "updatedAt") VALUES ('dddddddd-0000-0000-0000-000000000012', 'probe-b-clean@example.com', 'Probe User B', now(), now())`,
    );
    await rawClient.query(
      `INSERT INTO "Client" (id, name, "userId", "organizationId", "createdAt", "updatedAt") VALUES ('dddddddd-0000-0000-0000-000000000013', 'Probe Client B', 'dddddddd-0000-0000-0000-000000000012', $1, now(), now())`,
      [orgBId],
    );
    await rawClient.query(
      `INSERT INTO "Project" (id, name, "clientId", "organizationId", "ownerId", status, "createdAt", "updatedAt") VALUES ('dddddddd-0000-0000-0000-000000000014', 'Probe Project B', 'dddddddd-0000-0000-0000-000000000013', $1, 'dddddddd-0000-0000-0000-000000000012', 'IN_PROGRESS', now(), now())`,
      [orgBId],
    );
    await expect(
      rawClient.query(
        `INSERT INTO "Invoice" (id, "invoiceNumber", status, amount, "issueDate", "clientId", "projectId", "organizationId", "createdAt", "updatedAt")
         VALUES ('dddddddd-0000-0000-0000-000000000015', 'CLEAN-1', 'DRAFT', 30.00, now(), 'dddddddd-0000-0000-0000-000000000013', 'dddddddd-0000-0000-0000-000000000014', $1, now(), now())`,
        [orgBId],
      ),
    ).resolves.toBeDefined();

    await rawClient.end();
  }, 30_000);

  it("GREEN via real Prisma Client: a genuine organizationId+invoiceNumber P2002 reports the empirically verified driver-adapter fields shape", async () => {
    const port = 55615;
    const { databaseUrl, pglite, socketServer } = await startIsolatedDatabase(port);
    activeCleanup = async () => {
      await socketServer.stop();
      await pglite.close();
    };

    await execFileAsync("npx", ["prisma", "migrate", "deploy"], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl },
    });

    const adapter = new PrismaPg({ connectionString: databaseUrl });
    const prisma = new PrismaClient({ adapter });
    activeCleanup = async () => {
      await prisma.$disconnect();
      await socketServer.stop();
      await pglite.close();
    };

    const org = await prisma.organization.create({ data: { name: "Probe Org", slug: "probe-org-p2002" } });
    const user = await prisma.user.create({ data: { email: "probe-p2002@example.com", name: "Probe" } });
    const clientOne = await prisma.client.create({ data: { name: "Client One", userId: user.id, organizationId: org.id } });
    const clientTwo = await prisma.client.create({ data: { name: "Client Two", userId: user.id, organizationId: org.id } });
    const projectOne = await prisma.project.create({ data: { name: "Project One", clientId: clientOne.id, organizationId: org.id, ownerId: user.id, status: "IN_PROGRESS" } });
    const projectTwo = await prisma.project.create({ data: { name: "Project Two", clientId: clientTwo.id, organizationId: org.id, ownerId: user.id, status: "IN_PROGRESS" } });

    await prisma.invoice.create({
      data: { invoiceNumber: "P2002-PROBE-1", status: "DRAFT", amount: "10.00", clientId: clientOne.id, projectId: projectOne.id, organizationId: org.id },
    });

    let caught: unknown;
    try {
      await prisma.invoice.create({
        data: { invoiceNumber: "P2002-PROBE-1", status: "DRAFT", amount: "20.00", clientId: clientTwo.id, projectId: projectTwo.id, organizationId: org.id },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const known = caught as Prisma.PrismaClientKnownRequestError;
    expect(known.code).toBe("P2002");
    type DriverAdapterMeta = { driverAdapterError?: { cause?: { constraint?: { fields?: string[] } } } };
    const meta = (known.meta ?? {}) as DriverAdapterMeta;
    expect(meta.driverAdapterError?.cause?.constraint?.fields).toEqual(['"organizationId"', '"invoiceNumber"']);
  }, 30_000);
});
