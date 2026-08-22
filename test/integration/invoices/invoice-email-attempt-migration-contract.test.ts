import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";

/**
 * Invoice System Slice 4, PR 4a — the mandatory empirical evidence for
 * migration 20260914090000_add_invoice_email_attempt_pending_index,
 * required before any PR 4b production error mapper is written (per the
 * corrected Slice 4 design contract's own explicit instruction: "do not
 * guess P2002/raw-driver behavior").
 *
 * This repository has zero prior precedent anywhere for how Prisma
 * surfaces a violation of a raw-SQL, schema-DSL-invisible partial index —
 * confirmed directly: NotificationDelivery's own would-be partial index
 * was deliberately replaced with a plain composite index specifically
 * because "partial indexes aren't expressed by this Prisma version
 * without a preview feature this project doesn't otherwise need" (see
 * that model's own comment in prisma/schema.prisma). This test triggers
 * the real violation through the real generated Prisma Client, against
 * the real local PGlite-backed Postgres harness every migration in this
 * repository already runs against (test/support/local-postgres.ts,
 * applied once via global-setup.ts's own real `prisma migrate deploy`
 * subprocess before any test file runs) — never a mock, never a guess.
 *
 * No PR 4b production error-mapping code is added here — this file only
 * captures and asserts the observed shape itself, on stable fields only.
 */

const INVOICE_NUMBER_PREFIX = "INV-EMAIL-ATTEMPT-MIGRATION";

async function seedPlainInvoice(fixtures: TestFixtures) {
  return prisma.invoice.create({
    data: {
      invoiceNumber: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}-${randomUUID().slice(0, 8)}`,
      status: "SENT",
      amount: "100.00",
      subtotal: "100.00",
      discountAmount: "0.00",
      taxAmount: "0.00",
      projectId: fixtures.project.id,
      clientId: fixtures.clientA.id,
      organizationId: fixtures.orgA.id,
    },
  });
}

describe("InvoiceEmailAttempt — partial unique index migration contract (20260914090000)", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterAll(async () => {
    await prisma.invoiceEmailAttempt.deleteMany({ where: { invoice: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } } });
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await cleanupTestData(fixtures);
  });

  it("the exact migration index name and predicate exist in the database", async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE indexname = 'invoice_email_attempt_one_pending' AND tablename = 'InvoiceEmailAttempt'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain('"invoiceId"');
    expect(rows[0].indexdef.toLowerCase()).toContain("where");
    expect(rows[0].indexdef).toContain("'PENDING'");
  });

  it("two PENDING rows for the same invoice: the second is rejected by the partial index", async () => {
    const invoice = await seedPlainInvoice(fixtures);

    await prisma.invoiceEmailAttempt.create({
      data: { invoiceId: invoice.id, recipientEmail: "client@example.com", status: "PENDING", idempotencyKey: randomUUID() },
    });

    let caught: unknown;
    try {
      await prisma.invoiceEmailAttempt.create({
        data: { invoiceId: invoice.id, recipientEmail: "client@example.com", status: "PENDING", idempotencyKey: randomUUID() },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();

    // --- Empirical evidence, captured once, asserted only on the fields
    // actually observed to exist on this project's exact Prisma/driver-
    // adapter combination (@prisma/adapter-pg) — NOT the classic-engine
    // `meta.target` shape assumed in the corrected design contract, which
    // is confirmed ABSENT here for both this violation and the ordinary
    // idempotencyKey @unique violation below (`metaHasOwnTarget: false`
    // in both cases). The real, stable, distinguishing signal on this
    // project's own driver-adapter stack is
    // `meta.driverAdapterError.cause.constraint.fields` (and, equivalently,
    // the exact constraint name embedded in `originalMessage`) — captured
    // and asserted below.
    const isKnownRequestError = caught instanceof Prisma.PrismaClientKnownRequestError;
    const known = isKnownRequestError ? (caught as Prisma.PrismaClientKnownRequestError) : undefined;
    type DriverAdapterMeta = { driverAdapterError?: { cause?: { originalMessage?: string; constraint?: { fields?: string[] } } } };
    const meta = (known?.meta ?? {}) as DriverAdapterMeta;

    expect(isKnownRequestError).toBe(true);
    expect(known?.code).toBe("P2002");
    // `meta.target` (the classic-engine shape) is NOT populated on this
    // project's driver-adapter stack — asserted explicitly so a future
    // Prisma/adapter upgrade that changes this is caught as a real
    // regression against this empirical evidence, not silently assumed.
    expect(Object.prototype.hasOwnProperty.call(known?.meta ?? {}, "target")).toBe(false);
    // The one stable, verified distinguishing signal: the driver-adapter's
    // own reported constraint field list names exactly "invoiceId" for
    // the partial index — never "idempotencyKey".
    expect(meta.driverAdapterError?.cause?.constraint?.fields).toEqual(['"invoiceId"']);
    expect(meta.driverAdapterError?.cause?.originalMessage).toContain("invoice_email_attempt_one_pending");
  });

  it("PENDING rows for two different invoices are both allowed", async () => {
    const invoiceA = await seedPlainInvoice(fixtures);
    const invoiceB = await seedPlainInvoice(fixtures);

    await expect(
      prisma.invoiceEmailAttempt.create({
        data: { invoiceId: invoiceA.id, recipientEmail: "a@example.com", status: "PENDING", idempotencyKey: randomUUID() },
      }),
    ).resolves.toBeDefined();

    await expect(
      prisma.invoiceEmailAttempt.create({
        data: { invoiceId: invoiceB.id, recipientEmail: "b@example.com", status: "PENDING", idempotencyKey: randomUUID() },
      }),
    ).resolves.toBeDefined();
  });

  it("multiple ACCEPTED rows for one invoice are all allowed — the partial index scopes only PENDING", async () => {
    const invoice = await seedPlainInvoice(fixtures);
    for (let i = 0; i < 3; i++) {
      await expect(
        prisma.invoiceEmailAttempt.create({
          data: { invoiceId: invoice.id, recipientEmail: "client@example.com", status: "ACCEPTED", idempotencyKey: randomUUID() },
        }),
      ).resolves.toBeDefined();
    }
  });

  it("multiple FAILED rows for one invoice are all allowed", async () => {
    const invoice = await seedPlainInvoice(fixtures);
    for (let i = 0; i < 3; i++) {
      await expect(
        prisma.invoiceEmailAttempt.create({
          data: { invoiceId: invoice.id, recipientEmail: "client@example.com", status: "FAILED", idempotencyKey: randomUUID() },
        }),
      ).resolves.toBeDefined();
    }
  });

  it("multiple UNKNOWN rows for one invoice are all allowed", async () => {
    const invoice = await seedPlainInvoice(fixtures);
    for (let i = 0; i < 3; i++) {
      await expect(
        prisma.invoiceEmailAttempt.create({
          data: { invoiceId: invoice.id, recipientEmail: "client@example.com", status: "UNKNOWN", idempotencyKey: randomUUID() },
        }),
      ).resolves.toBeDefined();
    }
  });

  it("a terminal historical row plus one PENDING row for the same invoice is allowed", async () => {
    const invoice = await seedPlainInvoice(fixtures);
    await prisma.invoiceEmailAttempt.create({
      data: { invoiceId: invoice.id, recipientEmail: "client@example.com", status: "ACCEPTED", idempotencyKey: randomUUID() },
    });

    await expect(
      prisma.invoiceEmailAttempt.create({
        data: { invoiceId: invoice.id, recipientEmail: "client@example.com", status: "PENDING", idempotencyKey: randomUUID() },
      }),
    ).resolves.toBeDefined();
  });

  it("distinguishability: the ordinary global idempotencyKey @unique violation (Prisma-DSL-known) is a separate, independently-verifiable shape from the partial-index violation above", async () => {
    const invoiceA = await seedPlainInvoice(fixtures);
    const invoiceB = await seedPlainInvoice(fixtures);
    const sharedKey = randomUUID();

    await prisma.invoiceEmailAttempt.create({
      data: { invoiceId: invoiceA.id, recipientEmail: "a@example.com", status: "ACCEPTED", idempotencyKey: sharedKey },
    });

    let caught: unknown;
    try {
      await prisma.invoiceEmailAttempt.create({
        data: { invoiceId: invoiceB.id, recipientEmail: "b@example.com", status: "PENDING", idempotencyKey: sharedKey },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const known = caught as Prisma.PrismaClientKnownRequestError;
    type DriverAdapterMeta = { driverAdapterError?: { cause?: { originalMessage?: string; constraint?: { fields?: string[] } } } };
    const meta = (known.meta ?? {}) as DriverAdapterMeta;
    // The ordinary Prisma-DSL @unique constraint on idempotencyKey is also
    // observed to surface as P2002 with NO meta.target (this project's
    // driver-adapter stack never populates that classic-engine field,
    // contrary to the precedent in
    // src/app/(dashboard)/invoices/new/actions.ts, which was written
    // against a different Prisma engine mode) — the real distinguishing
    // signal is the same nested driverAdapterError.cause shape used above,
    // just naming a different constraint.
    expect(known.code).toBe("P2002");
    expect(Object.prototype.hasOwnProperty.call(known.meta ?? {}, "target")).toBe(false);
    expect(meta.driverAdapterError?.cause?.constraint?.fields).toEqual(['"idempotencyKey"']);
    expect(meta.driverAdapterError?.cause?.originalMessage).toContain("InvoiceEmailAttempt_idempotencyKey_key");

    // Cross-check: this idempotencyKey violation's own constraint field
    // list is reliably distinguishable from the partial-index violation's
    // own constraint field list captured in the earlier test — "invoiceId"
    // never appears here, and "idempotencyKey" never appears there. This
    // is the exact empirical gate PR 4b's own production error mapper must
    // implement, proven here rather than guessed.
    expect(meta.driverAdapterError?.cause?.constraint?.fields).not.toEqual(['"invoiceId"']);
    expect(meta.driverAdapterError?.cause?.originalMessage).not.toContain("invoice_email_attempt_one_pending");
  });
});
