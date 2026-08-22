import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { createActivity } from "@/lib/activity/create-activity";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, setMockAuthUser, resetAuthMock } from "../../support/auth-mock";
import type { Role, InvoiceStatus } from "@/generated/prisma/enums";

/**
 * Invoice System Official Slice 3, Legacy Archive — the retroactive
 * archival pipeline for an already-non-DRAFT invoice whose classification
 * is exactly legacy_eligible. Runs against the real repository database
 * harness (PGlite), mirroring test/integration/invoices/issue.test.ts's
 * own structure and conventions exactly. TEST_MODE is set ONLY here (see
 * issue.test.ts's own header comment for why it is never set globally).
 */

const ORIGINAL_TEST_MODE = process.env.TEST_MODE;
process.env.TEST_MODE = "1";

const { archiveLegacyInvoice } = await import("@/lib/invoices/pdf/legacy-archive-invoice");
const { archiveLegacyInvoiceAction } = await import("@/app/(dashboard)/invoices/[id]/edit/legacy-archive-actions");
const { testStorageRead } = await import("@/lib/storage/test-storage");
const { uploadInvoicePdfObject, removeInvoicePdfObject, buildInvoicePdfStoragePath } = await import("@/lib/invoices/pdf/storage");
const { GET: staffPdfGet } = await import("@/app/api/invoices/[id]/pdf/route");
const { GET: portalPdfGet } = await import("@/app/api/portal/invoices/[id]/pdf/route");

afterAll(() => {
  if (ORIGINAL_TEST_MODE === undefined) delete process.env.TEST_MODE;
  else process.env.TEST_MODE = ORIGINAL_TEST_MODE;
});

vi.mock("@/lib/activity/create-activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/activity/create-activity")>();
  return { ...actual, createActivity: vi.fn(actual.createActivity) };
});

const INVOICE_NUMBER_PREFIX = "INV-LEGACY";

type LegacyInvoiceOverrides = {
  status?: InvoiceStatus;
  amount?: string;
  subtotal?: string;
  discountAmount?: string;
  taxAmount?: string;
  discountType?: "NONE" | "PERCENTAGE" | "FIXED";
  discountValue?: string | null;
  taxRatePercent?: string | null;
  currency?: string;
  documentVersion?: number;
  paidAt?: Date | null;
  notes?: string;
  lineItems?: { description: string; quantity: string; unitPrice: string; lineTotal: string; position: number }[];
};

/**
 * A genuine legacy_eligible fixture — non-DRAFT, every *archive* field
 * (finalizedAt/pdfStoragePath/pdfGeneratedAt/snapshots — §4.6's own
 * classification) null by construction. subtotal/discountAmount/
 * taxAmount are unrelated to legacy_eligible classification and, since
 * Invoice System Official Slice 5b's NOT NULL contract, can never be
 * null for any real row — set here to the exact values Slice 1's own
 * historical backfill would have produced for a pre-feature flat
 * invoice (subtotal = amount, discount/tax = 0), not an arbitrary
 * non-null placeholder.
 */
async function seedLegacyInvoice(fixtures: TestFixtures, overrides: LegacyInvoiceOverrides = {}) {
  const { lineItems, ...rest } = overrides;
  return prisma.invoice.create({
    data: {
      invoiceNumber: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}-${randomUUID().slice(0, 8)}`,
      status: "SENT",
      amount: "500.00",
      subtotal: "500.00",
      discountAmount: "0.00",
      taxAmount: "0.00",
      discountType: "NONE",
      taxLabel: "TAX",
      currency: "USD",
      issueDate: new Date("2020-01-01T00:00:00.000Z"),
      projectId: fixtures.project.id,
      clientId: fixtures.clientA.id,
      organizationId: fixtures.orgA.id,
      ...rest,
      ...(lineItems ? { lineItems: { create: lineItems } } : {}),
    },
  });
}

function actorFor(fixtures: TestFixtures, user: { id: string; name: string }, role: Role) {
  return { organizationId: fixtures.orgA.id, userId: user.id, userName: user.name, role };
}

function isPdfSignature(buffer: Buffer): boolean {
  return buffer.subarray(0, 4).toString("latin1") === "%PDF";
}

const ELIGIBLE_STATUSES: InvoiceStatus[] = ["SENT", "PAID", "OVERDUE", "CANCELLED"];

// Every Invoice scalar this pipeline must never write, for the exact
// intended-change allowlist proof used throughout this file.
const IMMUTABLE_SCALARS = [
  "status",
  "amount",
  "paidAt",
  "issueDate",
  "dueDate",
  "invoiceNumber",
  "currency",
  "discountType",
  "discountValue",
  "taxRatePercent",
  "taxLabel",
  "clientId",
  "projectId",
  "organizationId",
  "notes",
  "internalNotes",
  "documentVersion",
] as const;

function expectImmutableScalarsUnchanged(before: Record<string, unknown>, after: Record<string, unknown>) {
  for (const field of IMMUTABLE_SCALARS) {
    const b = before[field];
    const a = after[field];
    const bVal = b && typeof b === "object" && "toFixed" in b ? (b as { toFixed: (n: number) => string }).toFixed(2) : b instanceof Date ? b.toISOString() : b;
    const aVal = a && typeof a === "object" && "toFixed" in a ? (a as { toFixed: (n: number) => string }).toFixed(2) : a instanceof Date ? a.toISOString() : a;
    expect(aVal, `expected ${field} to remain unchanged`).toEqual(bVal);
  }
}

describe("archiveLegacyInvoice — Invoice System Official Slice 3, Legacy Archive", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterAll(async () => {
    // Every deliberate-residue test above already cleans up its own
    // Storage object in its own finally block; this is a defensive sweep
    // so a successfully-archived (REFERENCED) test fixture's own real
    // TEST_MODE object — never removed by any individual test, since a
    // successful archive is supposed to keep its object — doesn't leak in
    // the process-wide Storage Map once this whole describe block's rows
    // are deleted. Scoped strictly to this suite's own two fixture
    // organizations, matching the existing deleteMany scope exactly.
    const residualLedgerRows = await prisma.invoicePdfArchiveObject.findMany({
      where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } },
    });
    for (const row of residualLedgerRows) {
      if (!row.invoiceId) continue;
      const identity = { organizationId: row.organizationId, invoiceId: row.invoiceId, documentVersion: row.documentVersion, archiveId: row.id };
      await removeInvoicePdfObject({ identity }).catch(() => {});
    }

    await prisma.invoicePdfArchiveObject.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await cleanupTestData(fixtures);
  });

  // --- Success path across all four eligible statuses, flat -----------------

  for (const status of ELIGIBLE_STATUSES) {
    it(`OWNER successfully archives a flat ${status} invoice with fully-null derived fields — status/amount/paidAt/documentVersion preserved, subtotal/discountAmount/taxAmount filled`, async () => {
      const paidAt = status === "PAID" ? new Date("2020-02-01T00:00:00.000Z") : null;
      const invoice = await seedLegacyInvoice(fixtures, { status, amount: "500.00", paidAt });
      const fixedNow = new Date("2026-08-19T12:00:00.000Z");

      const result = await archiveLegacyInvoice(
        { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
        { now: () => fixedNow },
      );

      expect(result).toEqual({ ok: true, outcome: "ARCHIVED", invoiceId: invoice.id, finalizedAt: fixedNow });

      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expectImmutableScalarsUnchanged(invoice, after);
      expect(after.finalizedAt?.toISOString()).toBe(fixedNow.toISOString());
      expect(after.pdfGeneratedAt?.toISOString()).toBe(fixedNow.toISOString());
      expect(after.pdfStoragePath).toBeTruthy();
      expect(after.issuerSnapshot).toBeTruthy();
      expect(after.recipientSnapshot).toBeTruthy();
      // Derived fields were null — filled from the authoritative calculation.
      expect(after.subtotal?.toFixed(2)).toBe("500.00");
      expect(after.discountAmount?.toFixed(2)).toBe("0.00");
      expect(after.taxAmount?.toFixed(2)).toBe("0.00");
      expect(after.amount.toFixed(2)).toBe("500.00");
      expect(after.paidAt?.toISOString() ?? null).toBe(paidAt?.toISOString() ?? null);

      const ledger = await prisma.invoicePdfArchiveObject.findFirstOrThrow({ where: { invoiceId: invoice.id } });
      expect(ledger.status).toBe("REFERENCED");
      expect(ledger.storagePath).toBe(after.pdfStoragePath);
      expect(ledger.documentVersion).toBe(1);

      const stored = testStorageRead("attachments", after.pdfStoragePath!);
      expect(stored).not.toBeNull();
      expect(isPdfSignature(stored!.body)).toBe(true);

      const activities = await prisma.activity.findMany({ where: { entityType: "INVOICE", entityId: invoice.id, action: "UPDATED" } });
      expect(activities).toHaveLength(1);
      expect(activities[0].metadata).toMatchObject({ changedFields: ["legacyArchive"] });

      // No STATUS_CHANGED Activity was ever created — status never changed.
      const statusChanged = await prisma.activity.findMany({ where: { entityType: "INVOICE", entityId: invoice.id, action: "STATUS_CHANGED" } });
      expect(statusChanged).toHaveLength(0);

      const notifications = await prisma.notification.findMany({ where: { activityId: activities[0].id } });
      expect(notifications).toHaveLength(0);

      const emailAttempts = await prisma.invoiceEmailAttempt.findMany({ where: { invoiceId: invoice.id } });
      expect(emailAttempts).toHaveLength(0);
      const notificationDeliveries = await prisma.notificationDelivery.findMany({ where: { notification: { activityId: activities[0].id } } });
      expect(notificationDeliveries).toHaveLength(0);
      const portalDownloadRequests = await prisma.portalDownloadRequest.count({ where: { organizationId: fixtures.orgA.id } });
      expect(portalDownloadRequests).toBe(0);
    });
  }

  it("OWNER successfully archives an itemized SENT invoice — line items recomputed from quantity/unitPrice, never trusting a stale persisted lineTotal, and no synthetic row is ever persisted", async () => {
    const invoice = await seedLegacyInvoice(fixtures, {
      amount: "220.00",
      // Consistent with the real line items below (10×$20.00 + 1×$20.00 =
      // $220.00) — since Invoice System Official Slice 5b's NOT NULL
      // contract, seedLegacyInvoice's own default subtotal/discountAmount/
      // taxAmount ("500.00"/"0.00"/"0.00") would otherwise mismatch this
      // test's own $220.00 amount and fail archiveLegacyInvoice's
      // financial-preservation check for an unrelated reason.
      subtotal: "220.00",
      discountAmount: "0.00",
      taxAmount: "0.00",
      lineItems: [
        { description: "Design work", quantity: "10", unitPrice: "20.00", lineTotal: "999.99", position: 0 },
        { description: "Hosting", quantity: "1", unitPrice: "20.00", lineTotal: "20.00", position: 1 },
      ],
    });

    const result = await archiveLegacyInvoice({
      actor: actorFor(fixtures, fixtures.owner, "OWNER"),
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });

    expect(result.ok).toBe(true);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.subtotal?.toFixed(2)).toBe("220.00");
    expect(after.amount.toFixed(2)).toBe("220.00");

    const lineItemsAfter = await prisma.invoiceLineItem.findMany({ where: { invoiceId: invoice.id }, orderBy: { position: "asc" } });
    expect(lineItemsAfter).toHaveLength(2);
    // Byte-for-byte unchanged — the stale lineTotal ("999.99") is never
    // rewritten on the persisted row; it was only ever recomputed
    // in-memory for the calculation/render.
    expect(lineItemsAfter[0].lineTotal.toFixed(2)).toBe("999.99");
    expect(lineItemsAfter[0].description).toBe("Design work");
    expect(lineItemsAfter[1].lineTotal.toFixed(2)).toBe("20.00");
  });

  // --- Financial preservation ------------------------------------------------

  describe("financial preservation", () => {
    it("all three derived fields already non-null and matching — archived successfully, values left byte-for-byte unchanged", async () => {
      const invoice = await seedLegacyInvoice(fixtures, {
        amount: "500.00",
        subtotal: "500.00",
        discountAmount: "0.00",
        taxAmount: "0.00",
      });

      const result = await archiveLegacyInvoice({
        actor: actorFor(fixtures, fixtures.owner, "OWNER"),
        invoiceId: invoice.id,
        expectedUpdatedAt: invoice.updatedAt.toISOString(),
      });

      expect(result.ok).toBe(true);
      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(after.subtotal?.toFixed(2)).toBe("500.00");
      expect(after.discountAmount?.toFixed(2)).toBe("0.00");
      expect(after.taxAmount?.toFixed(2)).toBe("0.00");
    });

    // Removed (Invoice System Official Slice 5b): this test previously
    // proved archiveLegacyInvoice()'s own conditional null-fill branch
    // (`...(subtotalWasNull ? { subtotal: calculation.subtotal } : {})` in
    // src/lib/invoices/pdf/legacy-archive-invoice.ts, and the equivalent
    // for discountAmount/taxAmount) — reachable only when one of these
    // three columns was null. Since Slice 5b's NOT NULL contract
    // (migration 20260915090000_add_invoice_totals_not_null_contract),
    // no Invoice row — real or test-seeded — can ever have a null
    // subtotal/discountAmount/taxAmount again; the database itself now
    // rejects it. That conditional-fill branch is therefore permanently
    // unreachable, structurally so, not merely unlikely — the exact same
    // "kept anyway as a defensive check, no longer testable because the
    // triggering condition cannot be constructed" situation this
    // repository already accepts elsewhere for its own defense-in-depth
    // guards. No production behavior changed: the branch simply never
    // fires, exactly as intended once the database guarantees its own
    // precondition can never occur. The still-reachable case — every
    // field already non-null and matching — remains covered by the test
    // immediately above.

    it("calculation failure (malformed line items) fails with INVALID_FINANCIAL_STATE, invoice fully unchanged", async () => {
      const invoice = await seedLegacyInvoice(fixtures, {
        amount: "500.00",
        lineItems: [{ description: "", quantity: "1", unitPrice: "10.00", lineTotal: "10.00", position: 0 }],
      });

      const result = await archiveLegacyInvoice({
        actor: actorFor(fixtures, fixtures.owner, "OWNER"),
        invoiceId: invoice.id,
        expectedUpdatedAt: invoice.updatedAt.toISOString(),
      });

      expect(result).toEqual({ ok: false, error: "INVALID_FINANCIAL_STATE" });
      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expectImmutableScalarsUnchanged(invoice, after);
      expect(after.finalizedAt).toBeNull();
      expect(await prisma.invoicePdfArchiveObject.count({ where: { invoiceId: invoice.id } })).toBe(0);
    });

    it("amount mismatch (calculated total disagrees with the persisted canonical amount) fails with INVALID_FINANCIAL_STATE, invoice fully unchanged", async () => {
      const invoice = await seedLegacyInvoice(fixtures, { amount: "999.00", subtotal: "500.00", discountAmount: "0.00", taxAmount: "0.00" });

      const result = await archiveLegacyInvoice({
        actor: actorFor(fixtures, fixtures.owner, "OWNER"),
        invoiceId: invoice.id,
        expectedUpdatedAt: invoice.updatedAt.toISOString(),
      });

      expect(result).toEqual({ ok: false, error: "INVALID_FINANCIAL_STATE" });
      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expectImmutableScalarsUnchanged(invoice, after);
      expect(after.finalizedAt).toBeNull();
      expect(await prisma.invoicePdfArchiveObject.count({ where: { invoiceId: invoice.id } })).toBe(0);
    });

    it("non-null subtotal mismatch fails with INVALID_FINANCIAL_STATE, invoice fully unchanged", async () => {
      const invoice = await seedLegacyInvoice(fixtures, { amount: "500.00", subtotal: "444.00", discountAmount: "0.00", taxAmount: "0.00" });

      const result = await archiveLegacyInvoice({
        actor: actorFor(fixtures, fixtures.owner, "OWNER"),
        invoiceId: invoice.id,
        expectedUpdatedAt: invoice.updatedAt.toISOString(),
      });

      expect(result).toEqual({ ok: false, error: "INVALID_FINANCIAL_STATE" });
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).finalizedAt).toBeNull();
    });

    it("non-null discountAmount mismatch fails with INVALID_FINANCIAL_STATE, invoice fully unchanged", async () => {
      const invoice = await seedLegacyInvoice(fixtures, { amount: "500.00", subtotal: "500.00", discountAmount: "10.00", taxAmount: "0.00" });

      const result = await archiveLegacyInvoice({
        actor: actorFor(fixtures, fixtures.owner, "OWNER"),
        invoiceId: invoice.id,
        expectedUpdatedAt: invoice.updatedAt.toISOString(),
      });

      expect(result).toEqual({ ok: false, error: "INVALID_FINANCIAL_STATE" });
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).finalizedAt).toBeNull();
    });

    it("non-null taxAmount mismatch fails with INVALID_FINANCIAL_STATE, invoice fully unchanged", async () => {
      const invoice = await seedLegacyInvoice(fixtures, { amount: "500.00", subtotal: "500.00", discountAmount: "0.00", taxAmount: "50.00" });

      const result = await archiveLegacyInvoice({
        actor: actorFor(fixtures, fixtures.owner, "OWNER"),
        invoiceId: invoice.id,
        expectedUpdatedAt: invoice.updatedAt.toISOString(),
      });

      expect(result).toEqual({ ok: false, error: "INVALID_FINANCIAL_STATE" });
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).finalizedAt).toBeNull();
    });
  });

  // --- Currency ---------------------------------------------------------------

  it("an unsupported currency fails with UNSUPPORTED_CURRENCY before any snapshot/render/ledger work, invoice fully unchanged", async () => {
    // JPY is zero-decimal — out of scope for invoice creation/archival (§6).
    const invoice = await seedLegacyInvoice(fixtures, { currency: "JPY", amount: "500", subtotal: "500", discountAmount: "0", taxAmount: "0" });

    const result = await archiveLegacyInvoice({
      actor: actorFor(fixtures, fixtures.owner, "OWNER"),
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });

    expect(result).toEqual({ ok: false, error: "UNSUPPORTED_CURRENCY" });
    expect(await prisma.invoicePdfArchiveObject.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });

  // --- documentVersion ----------------------------------------------------

  it("a non-1 persisted documentVersion is preserved exactly, never incremented or rewritten", async () => {
    const invoice = await seedLegacyInvoice(fixtures, { documentVersion: 3 });

    const result = await archiveLegacyInvoice({
      actor: actorFor(fixtures, fixtures.owner, "OWNER"),
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });

    expect(result.ok).toBe(true);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.documentVersion).toBe(3);
    expect(after.pdfStoragePath).toContain("/v3/");
    const ledger = await prisma.invoicePdfArchiveObject.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(ledger.documentVersion).toBe(3);
  });

  it("an invalid persisted documentVersion fails closed before any ledger or Storage write", async () => {
    const invoice = await seedLegacyInvoice(fixtures);
    // documentVersion has no DB-level CHECK constraint — simulate a
    // corrupted persisted value via a raw update, bypassing the app layer.
    await prisma.$executeRawUnsafe(`UPDATE "Invoice" SET "documentVersion" = 0 WHERE id = '${invoice.id}'`);

    const result = await archiveLegacyInvoice({
      actor: actorFor(fixtures, fixtures.owner, "OWNER"),
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });

    expect(result).toEqual({ ok: false, error: "ARCHIVE_FAILED" });
    expect(await prisma.invoicePdfArchiveObject.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });

  // --- Authorization / eligibility --------------------------------------------

  it("ADMIN is rejected with FORBIDDEN, and the invoice remains unarchived", async () => {
    const invoice = await seedLegacyInvoice(fixtures);
    const result = await archiveLegacyInvoice({
      actor: actorFor(fixtures, fixtures.admin, "ADMIN"),
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });
    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).finalizedAt).toBeNull();
  });

  it("MEMBER is rejected with FORBIDDEN, and the invoice remains unarchived", async () => {
    const invoice = await seedLegacyInvoice(fixtures);
    const result = await archiveLegacyInvoice({
      actor: actorFor(fixtures, fixtures.member, "MEMBER"),
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });
    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("a cross-organization invoiceId and a nonexistent invoiceId both return the identical NOT_FOUND result", async () => {
    const invoice = await seedLegacyInvoice(fixtures);
    const crossOrgActor = actorFor(fixtures, fixtures.orgBOwner, "OWNER");

    const crossOrgResult = await archiveLegacyInvoice({
      actor: { ...crossOrgActor, organizationId: fixtures.orgB.id },
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });
    const nonexistentResult = await archiveLegacyInvoice({
      actor: { ...crossOrgActor, organizationId: fixtures.orgB.id },
      invoiceId: randomUUID(),
      expectedUpdatedAt: new Date().toISOString(),
    });
    expect(crossOrgResult).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(nonexistentResult).toEqual({ ok: false, error: "NOT_FOUND" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).finalizedAt).toBeNull();
  });

  it("a DRAFT invoice is rejected with NOT_LEGACY_ELIGIBLE", async () => {
    const invoice = await seedLegacyInvoice(fixtures, { status: "DRAFT" });
    const result = await archiveLegacyInvoice({
      actor: actorFor(fixtures, fixtures.owner, "OWNER"),
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });
    expect(result).toEqual({ ok: false, error: "NOT_LEGACY_ELIGIBLE" });
  });

  it("an invariant_violation row (finalizedAt set, pdfStoragePath null) is rejected with INVARIANT_VIOLATION, never treated as legacy", async () => {
    const invoice = await seedLegacyInvoice(fixtures);
    await prisma.invoice.update({ where: { id: invoice.id }, data: { finalizedAt: new Date() } });
    const stale = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });

    const result = await archiveLegacyInvoice({
      actor: actorFor(fixtures, fixtures.owner, "OWNER"),
      invoiceId: invoice.id,
      expectedUpdatedAt: stale.updatedAt.toISOString(),
    });
    expect(result).toEqual({ ok: false, error: "INVARIANT_VIOLATION" });
  });

  it("an already-archived invoice returns ALREADY_ARCHIVED (ok: true) as an idempotent no-op — no new render, ledger, Storage object, or Activity", async () => {
    const invoice = await seedLegacyInvoice(fixtures);
    const first = await archiveLegacyInvoice({
      actor: actorFor(fixtures, fixtures.owner, "OWNER"),
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });
    expect(first.ok).toBe(true);

    const ledgerCountBefore = await prisma.invoicePdfArchiveObject.count({ where: { invoiceId: invoice.id } });
    const activityCountBefore = await prisma.activity.count({ where: { entityType: "INVOICE", entityId: invoice.id } });
    const afterFirst = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });

    const second = await archiveLegacyInvoice({
      actor: actorFor(fixtures, fixtures.owner, "OWNER"),
      invoiceId: invoice.id,
      // A stale expectedUpdatedAt (from the original pre-archive read) —
      // ALREADY_ARCHIVED is detected at the very first classifier read,
      // before the version check ever runs.
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });
    expect(second).toEqual({ ok: true, outcome: "ALREADY_ARCHIVED", invoiceId: invoice.id, finalizedAt: afterFirst.finalizedAt });

    expect(await prisma.invoicePdfArchiveObject.count({ where: { invoiceId: invoice.id } })).toBe(ledgerCountBefore);
    expect(await prisma.activity.count({ where: { entityType: "INVOICE", entityId: invoice.id } })).toBe(activityCountBefore);
    const afterSecond = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(afterSecond.pdfStoragePath).toBe(afterFirst.pdfStoragePath);
    expect(afterSecond.updatedAt.toISOString()).toBe(afterFirst.updatedAt.toISOString());
  });

  it("a stale expectedUpdatedAt is rejected before any render/upload work happens", async () => {
    const invoice = await seedLegacyInvoice(fixtures);
    const staleTimestamp = new Date(invoice.updatedAt.getTime() - 1000).toISOString();

    const result = await archiveLegacyInvoice({
      actor: actorFor(fixtures, fixtures.owner, "OWNER"),
      invoiceId: invoice.id,
      expectedUpdatedAt: staleTimestamp,
    });

    expect(result).toEqual({ ok: false, error: "STALE_VERSION" });
    expect(await prisma.invoicePdfArchiveObject.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });

  it("a status change DURING the operation (after the initial read, before the final transaction) causes CONFLICT — never silently commits a PDF labeled with a status the row no longer has", async () => {
    const invoice = await seedLegacyInvoice(fixtures, { status: "SENT" });

    const result = await archiveLegacyInvoice(
      {
        actor: actorFor(fixtures, fixtures.owner, "OWNER"),
        invoiceId: invoice.id,
        expectedUpdatedAt: invoice.updatedAt.toISOString(),
      },
      {
        // Simulate a concurrent status change happening in the render/upload
        // window, immediately before the final transaction's own guard runs.
        afterUploadBeforeFinalize: async () => {
          await prisma.invoice.update({
            where: { id: invoice.id },
            data: { status: "PAID", paidAt: new Date(), updatedAt: new Date(invoice.updatedAt.getTime() + 5000) },
          });
        },
      },
    );

    expect(result).toEqual({ ok: false, error: "CONFLICT" });
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("PAID");
    expect(after.finalizedAt).toBeNull();
    expect(after.pdfStoragePath).toBeNull();
    const ledger = await prisma.invoicePdfArchiveObject.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(ledger.status).toBe("CLEANED");
  });

  // --- Ledger / upload / transaction failure + compensation states A-D --------

  it("a ledger-creation failure (archiveId collision) performs no upload attempt", async () => {
    const invoice = await seedLegacyInvoice(fixtures);
    const collidingArchiveId = randomUUID();
    await prisma.invoicePdfArchiveObject.create({
      data: {
        id: collidingArchiveId,
        organizationId: fixtures.orgA.id,
        documentVersion: 1,
        storagePath: `organizations/${fixtures.orgA.id}/invoice-pdf/${randomUUID()}/v1/${randomUUID()}.pdf`,
        status: "PENDING_UPLOAD",
      },
    });

    let uploadCalled = false;
    const result = await archiveLegacyInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      {
        generateArchiveId: () => collidingArchiveId,
        upload: async (args) => {
          uploadCalled = true;
          return uploadInvoicePdfObject(args);
        },
      },
    );

    expect(result).toEqual({ ok: false, error: "ARCHIVE_FAILED" });
    expect(uploadCalled).toBe(false);
    await prisma.invoicePdfArchiveObject.delete({ where: { id: collidingArchiveId } });
  });

  /**
   * States A-D below all model an "ambiguous upload failure" — the exact
   * real-world case compensation exists for: a real Storage write that
   * genuinely completed, but whose provider response was lost/failed, so
   * archiveLegacyInvoice() itself only ever sees a bounded failure result.
   * Each test's own `upload` override calls the REAL uploadInvoicePdfObject()
   * with the exact args (identity + rendered PDF bytes) the service
   * generated, confirms that upload genuinely succeeded, and only then
   * reports failure back to the caller — so testStorageRead() below is
   * checking a real, previously-present TEST_MODE object, never an object
   * that was never written in the first place.
   */

  it("state A — real upload succeeds, removal succeeds, ledger transition succeeds: ledger CLEANED, object absent", async () => {
    const invoice = await seedLegacyInvoice(fixtures);
    let removedPath: string | null = null;
    // Captured, never asserted on INSIDE the override — archiveLegacyInvoice()
    // wraps deps.upload/deps.remove in its own try/catch, so an assertion
    // failure thrown from inside one of these callbacks would be silently
    // swallowed and converted to an ordinary upload/remove failure result,
    // never surfacing as a failed test. Every assertion below runs only
    // after archiveLegacyInvoice() has fully resolved.
    let realUploadResult: unknown;
    let uploadedBytesPrefix: string | undefined;

    const result = await archiveLegacyInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      {
        upload: async (args) => {
          realUploadResult = await uploadInvoicePdfObject(args);
          uploadedBytesPrefix = testStorageRead("attachments", buildInvoicePdfStoragePath(args.identity))?.body.subarray(0, 4).toString("latin1");
          return { ok: false, reason: "upload_failed" };
        },
        remove: async ({ identity }) => {
          removedPath = buildInvoicePdfStoragePath(identity);
          return removeInvoicePdfObject({ identity });
        },
      },
    );

    // The real object genuinely existed before compensation ran.
    expect(realUploadResult).toEqual({ ok: true });
    expect(uploadedBytesPrefix).toBe("%PDF");

    expect(result).toEqual({ ok: false, error: "UPLOAD_FAILED" });
    const ledger = await prisma.invoicePdfArchiveObject.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(ledger.status).toBe("CLEANED");
    expect(ledger.cleanedAt).not.toBeNull();
    expect(removedPath).toBe(ledger.storagePath);
    expect(testStorageRead("attachments", ledger.storagePath)).toBeNull();
  });

  it("state B — real upload succeeds, removal succeeds, but the ledger transition itself fails: ledger stays PENDING_UPLOAD, object absent", async () => {
    const invoice = await seedLegacyInvoice(fixtures);
    const updateManySpy = vi.spyOn(prisma.invoicePdfArchiveObject, "updateMany");
    // Captured, asserted only after archiveLegacyInvoice() resolves — see
    // state A's own header comment for why an in-callback assertion is
    // unsafe (it would be swallowed by the service's own try/catch).
    let realUploadResult: unknown;

    try {
      updateManySpy.mockRejectedValueOnce(
        new Error("simulated ledger-transition database failure — forced onto compensation's own CLEANED updateMany call"),
      );

      const result = await archiveLegacyInvoice(
        { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
        {
          upload: async (args) => {
            realUploadResult = await uploadInvoicePdfObject(args);
            return { ok: false, reason: "upload_failed" };
          },
          remove: async ({ identity }) => removeInvoicePdfObject({ identity }),
        },
      );
      expect(realUploadResult).toEqual({ ok: true });
      expect(result).toEqual({ ok: false, error: "UPLOAD_FAILED" });

      // The one-shot spy was consumed by compensation's own CLEANED
      // updateMany call — the final transaction is never reached in this
      // scenario (upload itself already failed), so no other write could
      // have been the one intercepted.
      expect(updateManySpy).toHaveBeenCalledTimes(1);
      expect(updateManySpy.mock.calls[0][0]).toMatchObject({ data: { status: "CLEANED" } });

      const ledger = await prisma.invoicePdfArchiveObject.findFirstOrThrow({ where: { invoiceId: invoice.id } });
      expect(ledger.status).toBe("PENDING_UPLOAD");
      expect(ledger.cleanedAt).toBeNull();
      // Removal itself genuinely succeeded — only the ledger write failed.
      expect(testStorageRead("attachments", ledger.storagePath)).toBeNull();
    } finally {
      updateManySpy.mockRestore();
      const ledger = await prisma.invoicePdfArchiveObject.findFirst({ where: { invoiceId: invoice.id } });
      if (ledger) {
        const identity = { organizationId: ledger.organizationId, invoiceId: invoice.id, documentVersion: ledger.documentVersion, archiveId: ledger.id };
        const removal = await removeInvoicePdfObject({ identity });
        expect(removal).toEqual({ ok: true });
        expect(testStorageRead("attachments", ledger.storagePath)).toBeNull();
        await prisma.invoicePdfArchiveObject.delete({ where: { id: ledger.id } });
      }
    }
  });

  it("state C — real upload succeeds, removal fails: ledger CLEANUP_PENDING with a bounded failure category and incremented attempt count, object present (orphaned)", async () => {
    const invoice = await seedLegacyInvoice(fixtures);
    let realUploadResult: unknown;

    const result = await archiveLegacyInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      {
        upload: async (args) => {
          realUploadResult = await uploadInvoicePdfObject(args);
          return { ok: false, reason: "upload_failed" };
        },
        // Object deliberately left untouched — removal genuinely fails.
        remove: async () => ({ ok: false, reason: "remove_failed" }),
      },
    );

    expect(realUploadResult).toEqual({ ok: true });
    expect(result).toEqual({ ok: false, error: "UPLOAD_FAILED" });
    const ledger = await prisma.invoicePdfArchiveObject.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    try {
      expect(ledger.status).toBe("CLEANUP_PENDING");
      expect(ledger.cleanupAttemptCount).toBe(1);
      expect(ledger.lastCleanupFailureCategory).toBe("remove_failed");
      expect(ledger.cleanedAt).toBeNull();
      const stored = testStorageRead("attachments", ledger.storagePath);
      expect(stored).not.toBeNull();
      expect(stored!.body.subarray(0, 4).toString("latin1")).toBe("%PDF");
    } finally {
      // Deterministic cleanup — this test deliberately leaves residue,
      // which must not leak into a later test.
      const removal = await removeInvoicePdfObject({
        identity: { organizationId: ledger.organizationId, invoiceId: invoice.id, documentVersion: ledger.documentVersion, archiveId: ledger.id },
      });
      expect(removal).toEqual({ ok: true });
      expect(testStorageRead("attachments", ledger.storagePath)).toBeNull();
      await prisma.invoicePdfArchiveObject.delete({ where: { id: ledger.id } });
    }
  });

  it("state D — real upload succeeds, removal fails, AND the ledger transition also fails: ledger stays PENDING_UPLOAD, object remains present (orphaned)", async () => {
    const invoice = await seedLegacyInvoice(fixtures);
    const updateManySpy = vi.spyOn(prisma.invoicePdfArchiveObject, "updateMany");
    let ledgerId: string | null = null;
    let realUploadResult: unknown;

    try {
      updateManySpy.mockRejectedValueOnce(
        new Error("simulated ledger-transition database failure — forced onto compensation's own CLEANUP_PENDING updateMany call"),
      );

      const result = await archiveLegacyInvoice(
        { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
        {
          upload: async (args) => {
            realUploadResult = await uploadInvoicePdfObject(args);
            return { ok: false, reason: "upload_failed" };
          },
          // Object deliberately left untouched — removal genuinely fails.
          remove: async () => ({ ok: false, reason: "remove_failed" }),
        },
      );
      expect(realUploadResult).toEqual({ ok: true });
      expect(result).toEqual({ ok: false, error: "UPLOAD_FAILED" });

      expect(updateManySpy).toHaveBeenCalledTimes(1);
      expect(updateManySpy.mock.calls[0][0]).toMatchObject({ data: { status: "CLEANUP_PENDING" } });

      const ledger = await prisma.invoicePdfArchiveObject.findFirstOrThrow({ where: { invoiceId: invoice.id } });
      ledgerId = ledger.id;
      expect(ledger.status).toBe("PENDING_UPLOAD");
      expect(ledger.cleanupAttemptCount).toBe(0);
      expect(ledger.lastCleanupFailureCategory).toBeNull();
      expect(ledger.cleanedAt).toBeNull();
      const stored = testStorageRead("attachments", ledger.storagePath);
      expect(stored).not.toBeNull();
      expect(stored!.body.subarray(0, 4).toString("latin1")).toBe("%PDF");
    } finally {
      updateManySpy.mockRestore();
      if (ledgerId) {
        const ledger = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: ledgerId } });
        const identity = { organizationId: ledger.organizationId, invoiceId: invoice.id, documentVersion: ledger.documentVersion, archiveId: ledger.id };
        const removal = await removeInvoicePdfObject({ identity });
        expect(removal).toEqual({ ok: true });
        expect(testStorageRead("attachments", ledger.storagePath)).toBeNull();
        await prisma.invoicePdfArchiveObject.delete({ where: { id: ledger.id } });
      }
    }
  });

  it("C2 — a thrown remove() during compensation is normalized to the bounded remove_failed category (a C-variant, never state D): raw exception never escapes or is persisted, ledger transition succeeds, final status CLEANUP_PENDING, object remains present until deterministic teardown", async () => {
    const invoice = await seedLegacyInvoice(fixtures);
    const RAW_ERROR = new Error("simulated storage provider exception during removal — must never be persisted or thrown");
    let realUploadResult: unknown;

    const result = await archiveLegacyInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      {
        upload: async (args) => {
          realUploadResult = await uploadInvoicePdfObject(args);
          return { ok: false, reason: "upload_failed" };
        },
        remove: async () => {
          throw RAW_ERROR;
        },
      },
    );

    expect(realUploadResult).toEqual({ ok: true });
    // The raw exception never escapes archiveLegacyInvoice() itself —
    // the same bounded UPLOAD_FAILED result as every other ambiguous
    // upload failure, never a thrown error.
    expect(result).toEqual({ ok: false, error: "UPLOAD_FAILED" });

    const ledger = await prisma.invoicePdfArchiveObject.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    try {
      // Ledger transition itself succeeds in this variant — this is a
      // C-outcome (removal failed, ledger write succeeded), never state D.
      expect(ledger.status).toBe("CLEANUP_PENDING");
      expect(ledger.cleanupAttemptCount).toBe(1);
      expect(ledger.lastCleanupFailureCategory).toBe("remove_failed");
      expect(ledger.cleanedAt).toBeNull();
      const stored = testStorageRead("attachments", ledger.storagePath);
      expect(stored).not.toBeNull();
      expect(stored!.body.subarray(0, 4).toString("latin1")).toBe("%PDF");
    } finally {
      const removal = await removeInvoicePdfObject({
        identity: { organizationId: ledger.organizationId, invoiceId: invoice.id, documentVersion: ledger.documentVersion, archiveId: ledger.id },
      });
      expect(removal).toEqual({ ok: true });
      expect(testStorageRead("attachments", ledger.storagePath)).toBeNull();
      await prisma.invoicePdfArchiveObject.delete({ where: { id: ledger.id } });
    }
  });

  it("an upload adapter that throws is treated as an ambiguous UPLOAD_FAILED, and never lets the raw exception escape", async () => {
    const invoice = await seedLegacyInvoice(fixtures);
    let removeCalled = false;

    const result = await archiveLegacyInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      {
        upload: async () => {
          throw new Error("simulated network exception during upload");
        },
        remove: async () => {
          removeCalled = true;
          return { ok: true };
        },
      },
    );

    expect(result).toEqual({ ok: false, error: "UPLOAD_FAILED" });
    expect(removeCalled).toBe(true);
    const ledger = await prisma.invoicePdfArchiveObject.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(ledger.status).toBe("CLEANED");
  });

  it("a forced Activity-write failure rolls back the Invoice/ledger transition together, then compensates the uploaded object", async () => {
    const invoice = await seedLegacyInvoice(fixtures);
    vi.mocked(createActivity).mockRejectedValueOnce(new Error("simulated activity failure"));

    const result = await archiveLegacyInvoice({
      actor: actorFor(fixtures, fixtures.owner, "OWNER"),
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });

    expect(result).toEqual({ ok: false, error: "ARCHIVE_FAILED" });
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe(invoice.status);
    expect(after.pdfStoragePath).toBeNull();
    expect(after.finalizedAt).toBeNull();

    const activities = await prisma.activity.findMany({ where: { entityType: "INVOICE", entityId: invoice.id, action: "UPDATED" } });
    expect(activities).toHaveLength(0);

    const ledger = await prisma.invoicePdfArchiveObject.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(ledger.status).toBe("CLEANED");
    expect(testStorageRead("attachments", ledger.storagePath)).toBeNull();
  });

  // --- Crash boundary (state E) ------------------------------------------------

  it("state E — a real process crash simulated at the exact post-upload/pre-transaction boundary leaves the ledger row discoverable at PENDING_UPLOAD, object present, Invoice untouched, no compensation attempted", async () => {
    const invoice = await seedLegacyInvoice(fixtures, { notes: "pre-crash notes" });
    const CRASH_MARKER = new Error("simulated process crash — deliberately not caught by archiveLegacyInvoice() itself");

    await expect(
      archiveLegacyInvoice(
        { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
        { afterUploadBeforeFinalize: () => { throw CRASH_MARKER; } },
      ),
    ).rejects.toThrow(CRASH_MARKER);

    const ledger = await prisma.invoicePdfArchiveObject.findFirstOrThrow({ where: { invoiceId: invoice.id } });

    try {
      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(after.status).toBe(invoice.status);
      expect(after.notes).toBe("pre-crash notes");
      expect(after.finalizedAt).toBeNull();
      expect(after.pdfStoragePath).toBeNull();

      const activities = await prisma.activity.findMany({ where: { entityType: "INVOICE", entityId: invoice.id, action: "UPDATED" } });
      expect(activities).toHaveLength(0);

      expect(ledger.status).toBe("PENDING_UPLOAD");
      const stored = testStorageRead("attachments", ledger.storagePath);
      expect(stored).not.toBeNull();
      expect(isPdfSignature(stored!.body)).toBe(true);

      const discoverable = await prisma.invoicePdfArchiveObject.findMany({ where: { status: { in: ["PENDING_UPLOAD", "CLEANUP_PENDING"] } } });
      expect(discoverable.some((row) => row.id === ledger.id)).toBe(true);
    } finally {
      const identity = { organizationId: ledger.organizationId, invoiceId: invoice.id, documentVersion: ledger.documentVersion, archiveId: ledger.id };
      const removal = await removeInvoicePdfObject({ identity });
      expect(removal).toEqual({ ok: true });
      await prisma.invoicePdfArchiveObject.delete({ where: { id: ledger.id } });
    }
  });

  // --- Concurrency --------------------------------------------------------

  it("two simultaneous archive attempts produce exactly one REFERENCED ledger row; the loser's own ledger/object is fully cleaned; the Invoice references only the winner's path; Activity exists only for the winner", async () => {
    const invoice = await seedLegacyInvoice(fixtures);
    const input = {
      actor: actorFor(fixtures, fixtures.owner, "OWNER"),
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    };

    const [a, b] = await Promise.all([archiveLegacyInvoice(input), archiveLegacyInvoice(input)]);
    const results = [a, b];

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe(invoice.status);

    const referenced = await prisma.invoicePdfArchiveObject.findMany({ where: { invoiceId: invoice.id, status: "REFERENCED" } });
    expect(referenced).toHaveLength(1);
    expect(referenced[0].storagePath).toBe(after.pdfStoragePath);

    const activities = await prisma.activity.findMany({ where: { entityType: "INVOICE", entityId: invoice.id, action: "UPDATED" } });
    expect(activities).toHaveLength(1);

    // Both attempts registered their own ledger row before either uploaded
    // — this is the exhaustive set of every path either attempt could have
    // written to Storage.
    const allLedgerRows = await prisma.invoicePdfArchiveObject.findMany({ where: { invoiceId: invoice.id } });
    expect(allLedgerRows.length).toBeGreaterThanOrEqual(2);

    let liveObjectCount = 0;
    for (const row of allLedgerRows) {
      const stored = testStorageRead("attachments", row.storagePath);
      if (row.status === "REFERENCED") {
        expect(stored).not.toBeNull();
        expect(isPdfSignature(stored!.body)).toBe(true);
        liveObjectCount += 1;
      } else {
        // The clean (non-fault-injected) concurrency case always resolves
        // the loser's compensation to a fully confirmed CLEANED state.
        expect(row.status).toBe("CLEANED");
        expect(stored).toBeNull();
      }
    }
    expect(liveObjectCount).toBe(1);
  });
});

describe("archiveLegacyInvoiceAction — full-stack wiring (Server Action -> service)", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(() => {
    resetAuthMock();
  });

  afterAll(async () => {
    await prisma.invoicePdfArchiveObject.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await cleanupTestData(fixtures);
  });

  it("OWNER can archive via the real Server Action, and the public result contains no private path", async () => {
    actAs({ id: fixtures.owner.id, email: fixtures.owner.email }, fixtures.orgA.id);
    const invoice = await seedLegacyInvoice(fixtures);

    const result = await archiveLegacyInvoiceAction(invoice.id, invoice.updatedAt.toISOString());

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("organizations/");
    expect(JSON.stringify(result)).not.toContain(".pdf");
  });

  it("ADMIN calling the real Server Action is rejected with FORBIDDEN", async () => {
    actAs({ id: fixtures.admin.id, email: fixtures.admin.email }, fixtures.orgA.id);
    const invoice = await seedLegacyInvoice(fixtures);
    const result = await archiveLegacyInvoiceAction(invoice.id, invoice.updatedAt.toISOString());
    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("MEMBER calling the real Server Action is rejected with FORBIDDEN", async () => {
    actAs({ id: fixtures.member.id, email: fixtures.member.email }, fixtures.orgA.id);
    const invoice = await seedLegacyInvoice(fixtures);
    const result = await archiveLegacyInvoiceAction(invoice.id, invoice.updatedAt.toISOString());
    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("a Client Portal-only identity cannot invoke the action — redirected to /portal by getOrCreateUser(), the same staff-only boundary every other staff action already has, never reaching archiveLegacyInvoice() at all", async () => {
    actAs({ id: fixtures.portalUser.id, email: fixtures.portalUser.email }, fixtures.orgA.id);
    const invoice = await seedLegacyInvoice(fixtures);
    await expect(archiveLegacyInvoiceAction(invoice.id, invoice.updatedAt.toISOString())).rejects.toThrow("REDIRECT:/portal");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).finalizedAt).toBeNull();
  });
});

describe("Legacy Archive interop — existing staff and Portal PDF routes serve the result unmodified", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(() => {
    resetAuthMock();
  });

  afterAll(async () => {
    await prisma.invoicePdfArchiveObject.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await cleanupTestData(fixtures);
  });

  it("the existing staff PDF route serves a Legacy-Archived invoice with no route-level change — 307 to the TEST_MODE storage path", async () => {
    const invoice = await seedLegacyInvoice(fixtures);
    const archiveResult = await archiveLegacyInvoice({
      actor: actorFor(fixtures, fixtures.owner, "OWNER"),
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });
    expect(archiveResult.ok).toBe(true);

    actAs({ id: fixtures.owner.id, email: fixtures.owner.email }, fixtures.orgA.id);
    const response = await staffPdfGet(new Request(`http://localhost/api/invoices/${invoice.id}/pdf`), { params: Promise.resolve({ id: invoice.id }) });

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toContain("/api/e2e-test-storage/attachments/");
  });

  it("the existing Portal PDF route serves a Legacy-Archived invoice to the correct connected Client, and same-org/different-Client isolation remains intact", async () => {
    const invoice = await seedLegacyInvoice(fixtures);
    const archiveResult = await archiveLegacyInvoice({
      actor: actorFor(fixtures, fixtures.owner, "OWNER"),
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });
    expect(archiveResult.ok).toBe(true);

    setMockAuthUser({ id: fixtures.portalUser.id, email: fixtures.portalUser.email });
    const response = await portalPdfGet(new Request(`http://localhost/api/portal/invoices/${invoice.id}/pdf`), { params: Promise.resolve({ id: invoice.id }) });
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toContain("/api/e2e-test-storage/attachments/");
  });

  it("a Portal identity connected to a different Client in the same organization cannot download the archived invoice — generic 404, isolation intact", async () => {
    const invoice = await seedLegacyInvoice(fixtures);
    const archiveResult = await archiveLegacyInvoice({
      actor: actorFor(fixtures, fixtures.owner, "OWNER"),
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });
    expect(archiveResult.ok).toBe(true);

    const otherClient = await prisma.client.create({ data: { name: "Other Client (same org)", organizationId: fixtures.orgA.id, userId: fixtures.owner.id } });
    const otherPortalUserId = randomUUID();
    const otherPortalUser = await prisma.portalUser.create({
      data: { id: otherPortalUserId, clientId: otherClient.id, email: `legacy-archive-other-${fixtures.runId}@example.test`, name: "Other Portal User" },
    });

    try {
      setMockAuthUser({ id: otherPortalUser.id, email: otherPortalUser.email });
      const response = await portalPdfGet(new Request(`http://localhost/api/portal/invoices/${invoice.id}/pdf`), { params: Promise.resolve({ id: invoice.id }) });
      expect(response.status).toBe(404);
    } finally {
      await prisma.portalUser.delete({ where: { id: otherPortalUser.id } });
      await prisma.client.delete({ where: { id: otherClient.id } });
    }
  });
});
