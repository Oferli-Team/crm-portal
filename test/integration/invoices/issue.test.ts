import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { createActivity } from "@/lib/activity/create-activity";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import type { Role } from "@/generated/prisma/enums";

/**
 * Invoice System Official Slice 3, sub-PR 3b — the live Issue/finalization
 * pipeline. Runs against the real repository database harness (PGlite).
 *
 * Most tests below use issueInvoice()'s own dependency injection (upload/
 * remove/resolveLogo/render/now/generateArchiveId/deliverEmails) to control
 * outcomes directly, as plain function arguments — this never depends on
 * process.env.TEST_MODE at all. The one exception is the final
 * "issueInvoiceAction — full-stack wiring" describe block below, whose own
 * success-path test calls the real Server Action with NO deps override
 * (Server Actions correctly accept no fault-injection parameter) — that
 * one test needs storage.ts/logo.ts's own real TEST_MODE branch to avoid
 * touching real Supabase Storage. TEST_MODE is set ONLY here, in this
 * file's own top-level code (never in the shared test/integration/
 * setup-env.ts) — precisely because setting it there was tried first and
 * found to leak into and change the behavior of unrelated TEST_MODE-
 * checking code in OTHER integration test files (e.g.
 * src/lib/billing/provider/provider.ts's own provider-selection branch,
 * which prioritizes TEST_MODE over real Paddle config). Every PDF-module
 * import below is therefore a top-level dynamic import performed AFTER
 * setting TEST_MODE=1, exactly matching test/unit/recovery-token.test.ts's
 * own established technique — this file's own isolated module registry
 * is unaffected by, and never affects, any other test file's.
 */

const ORIGINAL_TEST_MODE = process.env.TEST_MODE;
process.env.TEST_MODE = "1";

const { issueInvoice } = await import("@/lib/invoices/pdf/issue-invoice");
const { issueInvoiceAction } = await import("@/app/(dashboard)/invoices/[id]/edit/issue-actions");
const { testStorageRead } = await import("@/lib/storage/test-storage");
const { uploadInvoicePdfObject, removeInvoicePdfObject, buildInvoicePdfStoragePath } = await import("@/lib/invoices/pdf/storage");
const { renderInvoicePdfBuffer } = await import("@/lib/invoices/pdf/document");
const { parseIssuerSnapshot, parseRecipientSnapshot } = await import("@/lib/invoices/pdf/snapshot-types");
const { toRendererIssuerPresentation, toRendererRecipientPresentation } = await import("@/lib/invoices/pdf/view-model");
const { calculateInvoiceTotals } = await import("@/lib/invoices/calculations");
const { buildInvoiceTotalsViewModel } = await import("@/lib/invoices/totals-view-model");
const { formatInvoiceCurrencyAmount } = await import("@/lib/invoices/currencies");

/**
 * A genuine, real, decodable 1x1 transparent PNG — the exact same fixture
 * already used and proven valid elsewhere in this repo's own test suite
 * (test/e2e/organization-setup.spec.ts's own logo-upload fixture), reused
 * here rather than arbitrary text labelled as an image, per this
 * correction pass's own §7 requirement.
 */
const GENUINE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const GENUINE_PNG_BYTES = Buffer.from(GENUINE_PNG_BASE64, "base64");

afterAll(() => {
  if (ORIGINAL_TEST_MODE === undefined) delete process.env.TEST_MODE;
  else process.env.TEST_MODE = ORIGINAL_TEST_MODE;
});

vi.mock("@/lib/activity/create-activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/activity/create-activity")>();
  return { ...actual, createActivity: vi.fn(actual.createActivity) };
});

const INVOICE_NUMBER_PREFIX = "INV-ISSUE";

type DraftInvoiceOverrides = {
  status?: "DRAFT" | "SENT" | "PAID" | "OVERDUE" | "CANCELLED";
  amount?: string;
  subtotal?: string;
  notes?: string;
  discountType?: "NONE" | "PERCENTAGE" | "FIXED";
  discountValue?: string;
  taxRatePercent?: string;
};

async function seedDraftInvoice(fixtures: TestFixtures, overrides: DraftInvoiceOverrides = {}) {
  return prisma.invoice.create({
    data: {
      invoiceNumber: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}-${randomUUID().slice(0, 8)}`,
      status: "DRAFT",
      amount: "500.00",
      subtotal: "500.00",
      discountAmount: "0.00",
      taxAmount: "0.00",
      discountType: "NONE",
      taxLabel: "TAX",
      currency: "USD",
      issueDate: new Date("2026-01-01T00:00:00.000Z"),
      projectId: fixtures.project.id,
      clientId: fixtures.clientA.id,
      organizationId: fixtures.orgA.id,
      ...overrides,
    },
  });
}

function actorFor(fixtures: TestFixtures, user: { id: string; name: string }, role: Role) {
  return { organizationId: fixtures.orgA.id, userId: user.id, userName: user.name, role };
}

function isPdfSignature(buffer: Buffer): boolean {
  return buffer.subarray(0, 4).toString("latin1") === "%PDF";
}

describe("issueInvoice — Invoice System Official Slice 3, sub-PR 3b", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterAll(async () => {
    await prisma.invoicePdfArchiveObject.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await cleanupTestData(fixtures);
  });

  // --- 1-11: OWNER success path, flat and itemized ---------------------------

  it("OWNER successfully issues a flat DRAFT — status SENT, totals/snapshots/ledger/PDF/Activity/Notification all consistent", async () => {
    const invoice = await seedDraftInvoice(fixtures, { amount: "500.00", subtotal: "500.00" });
    const fixedNow = new Date("2026-08-17T12:00:00.000Z");

    const result = await issueInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      { now: () => fixedNow },
    );

    expect(result).toEqual({ ok: true, invoiceId: invoice.id, finalizedAt: fixedNow });

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("SENT");
    expect(after.finalizedAt?.toISOString()).toBe(fixedNow.toISOString());
    expect(after.pdfGeneratedAt?.toISOString()).toBe(fixedNow.toISOString());
    expect(after.paidAt).toBeNull();
    expect(after.amount.toFixed(2)).toBe("500.00");
    expect(after.subtotal?.toFixed(2)).toBe("500.00");
    expect(after.discountAmount?.toFixed(2)).toBe("0.00");
    expect(after.taxAmount?.toFixed(2)).toBe("0.00");
    expect(after.pdfStoragePath).toBeTruthy();
    expect(after.issuerSnapshot).toBeTruthy();
    expect(after.recipientSnapshot).toBeTruthy();

    const ledger = await prisma.invoicePdfArchiveObject.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(ledger.status).toBe("REFERENCED");
    expect(ledger.storagePath).toBe(after.pdfStoragePath);
    expect(ledger.referencedAt?.toISOString()).toBe(fixedNow.toISOString());

    const stored = testStorageRead("attachments", after.pdfStoragePath!);
    expect(stored).not.toBeNull();
    expect(isPdfSignature(stored!.body)).toBe(true);
    expect(stored!.contentType).toBe("application/pdf");

    const activities = await prisma.activity.findMany({ where: { entityType: "INVOICE", entityId: invoice.id, action: "STATUS_CHANGED" } });
    expect(activities).toHaveLength(1);

    const notifications = await prisma.notification.findMany({ where: { activityId: activities[0].id } });
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications.every((n) => n.type === "INVOICE_STATUS_CHANGED")).toBe(true);

    const emailAttempts = await prisma.invoiceEmailAttempt.findMany({ where: { invoiceId: invoice.id } });
    expect(emailAttempts).toHaveLength(0);
  });

  it("OWNER successfully issues an itemized DRAFT — persisted totals equal the authoritative calculation result", async () => {
    const invoice = await seedDraftInvoice(fixtures, { amount: "0.00", subtotal: "0.00" });
    await prisma.invoiceLineItem.createMany({
      data: [
        { invoiceId: invoice.id, description: "Design", quantity: "2", unitPrice: "50.00", lineTotal: "100.00", position: 0 },
        { invoiceId: invoice.id, description: "Hosting", quantity: "1", unitPrice: "29.99", lineTotal: "29.99", position: 1 },
      ],
    });

    const result = await issueInvoice({
      actor: actorFor(fixtures, fixtures.owner, "OWNER"),
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });

    expect(result.ok).toBe(true);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("SENT");
    expect(after.subtotal?.toFixed(2)).toBe("129.99");
    expect(after.amount.toFixed(2)).toBe("129.99");

    const stored = testStorageRead("attachments", after.pdfStoragePath!);
    expect(isPdfSignature(stored!.body)).toBe(true);
  });

  it("persisted snapshots equal what was strictly parsed/used for rendering — the captured view model's own issuer/recipient presentation exactly matches what the persisted snapshots re-derive, and persisted totals/line items exactly match the authoritative calculation the render actually used (recomputed from quantity/unitPrice, never the stale persisted lineTotal)", async () => {
    const invoice = await seedDraftInvoice(fixtures, {
      amount: "0.00",
      subtotal: "0.00",
      discountType: "PERCENTAGE",
      discountValue: "10",
      taxRatePercent: "8",
    });
    // Deliberately wrong persisted lineTotal on both rows — real
    // quantity * unitPrice is 120.00 and 31.00 respectively; the stored
    // lineTotal values below are neither of those. If the service ever
    // trusted the persisted lineTotal instead of recomputing from
    // quantity/unitPrice, the assertions below (derived from the real
    // primitives) would fail.
    await prisma.invoiceLineItem.createMany({
      data: [
        { invoiceId: invoice.id, description: "Design", quantity: "3", unitPrice: "40.00", lineTotal: "999.99", position: 0 },
        { invoiceId: invoice.id, description: "Hosting", quantity: "2", unitPrice: "15.50", lineTotal: "1.00", position: 1 },
      ],
    });

    let capturedViewModel: Parameters<typeof renderInvoicePdfBuffer>[0] | null = null;

    const result = await issueInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      {
        render: async (viewModel) => {
          // Capture the exact view model actually handed to the renderer,
          // then let the real renderer execute unmodified — this proves
          // the persisted snapshots correspond to what was truly rendered,
          // not merely to some other equivalent-looking object.
          capturedViewModel = viewModel;
          return renderInvoicePdfBuffer(viewModel);
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(capturedViewModel).not.toBeNull();

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });

    const parsedIssuer = parseIssuerSnapshot(after.issuerSnapshot);
    const parsedRecipient = parseRecipientSnapshot(after.recipientSnapshot);
    expect(parsedIssuer.ok).toBe(true);
    expect(parsedRecipient.ok).toBe(true);
    if (!parsedIssuer.ok || !parsedRecipient.ok) throw new Error("unreachable");

    // Re-run the persisted snapshots through the exact same renderer
    // presentation adapters the service itself uses, and assert the
    // result is byte-for-byte identical to what was actually captured on
    // the way into the real renderer.
    const rederivedIssuer = toRendererIssuerPresentation(parsedIssuer.snapshot, null);
    // The default fixture organization has no logo configured, so the
    // captured presentation has no logoImage either — verified explicitly
    // rather than assumed.
    expect(capturedViewModel!.issuer.logoImage).toBeNull();
    expect(rederivedIssuer).toEqual({ ok: true, presentation: capturedViewModel!.issuer });

    const rederivedRecipient = toRendererRecipientPresentation(parsedRecipient.snapshot);
    expect(rederivedRecipient).toEqual(capturedViewModel!.recipient);

    // The one authoritative calculation, derived here from the exact same
    // persisted primitives (description/quantity/unitPrice, discount,
    // taxRatePercent) the service itself reads — never a second,
    // independently hand-computed set of money values. This is the same
    // helper the production pipeline calls; using it here (rather than
    // duplicating the arithmetic in the test) is what lets the assertions
    // below prove "the persisted values equal the authoritative
    // calculation" instead of merely "the persisted values equal what I
    // assumed they'd be."
    const expectedCalculation = calculateInvoiceTotals({
      subtotalSource: {
        mode: "lineItems",
        lineItems: [
          { description: "Design", quantity: "3", unitPrice: "40.00" },
          { description: "Hosting", quantity: "2", unitPrice: "15.50" },
        ],
      },
      discount: { type: "PERCENTAGE", value: "10" },
      taxRatePercent: "8",
    });
    expect(expectedCalculation.ok).toBe(true);
    if (!expectedCalculation.ok) throw new Error("unreachable");

    // Sanity: this fixture genuinely exercises non-zero subtotal,
    // discount, tax, and total — not a degenerate all-zero case.
    expect(expectedCalculation.subtotal.toFixed(2)).toBe("151.00");
    expect(expectedCalculation.discountAmount.toFixed(2)).toBe("15.10");
    expect(expectedCalculation.taxAmount.toFixed(2)).toBe("10.87");
    expect(expectedCalculation.total.toFixed(2)).toBe("146.77");

    // Persisted Invoice fields exactly match the authoritative
    // calculation — never the stale persisted lineTotal, never a second
    // independently-derived total.
    expect(after.subtotal?.toFixed(2)).toBe(expectedCalculation.subtotal.toFixed(2));
    expect(after.discountAmount?.toFixed(2)).toBe(expectedCalculation.discountAmount.toFixed(2));
    expect(after.taxAmount?.toFixed(2)).toBe(expectedCalculation.taxAmount.toFixed(2));
    expect(after.amount.toFixed(2)).toBe(expectedCalculation.total.toFixed(2));

    // The captured render view model's own totals block, re-derived
    // through the exact same formatting helper the service itself calls
    // (buildInvoiceTotalsViewModel), from the exact same calculation.
    const expectedTotals = buildInvoiceTotalsViewModel({
      amount: expectedCalculation.total,
      subtotal: expectedCalculation.subtotal,
      discountType: "PERCENTAGE",
      discountAmount: expectedCalculation.discountAmount,
      discountValue: "10",
      taxRatePercent: "8",
      taxAmount: expectedCalculation.taxAmount,
      taxLabel: "TAX",
      currency: "USD",
    });
    expect(capturedViewModel!.totals).toEqual(expectedTotals);

    // Every rendered line item's own quantity/unitPrice/lineTotal —
    // recomputed from the persisted primitives (never the stale
    // persisted lineTotal above), formatted through the exact same
    // currency helper the service itself calls.
    const format = (value: string) => formatInvoiceCurrencyAmount(value, "USD", "en-US");
    expect(capturedViewModel!.lineItems).toEqual([
      { description: "Design", quantity: "3", unitPrice: format("40.00"), lineTotal: format("120.00") },
      { description: "Hosting", quantity: "2", unitPrice: format("15.50"), lineTotal: format("31.00") },
    ]);
    expect(capturedViewModel!.isFlatSynthetic).toBe(false);
  });

  // --- 12: notification delivery only after commit ----------------------------

  it("notification delivery runs only after the DB transaction has already committed", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const callOrder: string[] = [];

    const result = await issueInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      {
        deliverEmails: async (ids) => {
          callOrder.push("deliverEmails");
          const row = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
          // The Invoice must already be committed as SENT by the time delivery runs.
          expect(row.status).toBe("SENT");
          return { attempted: ids.length, sent: 0, failed: 0, skipped: ids.length };
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(callOrder).toEqual(["deliverEmails"]);
  });

  // --- 14-15: role rejection ---------------------------------------------------

  it("ADMIN is rejected with FORBIDDEN, and the invoice remains DRAFT", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const result = await issueInvoice({
      actor: actorFor(fixtures, fixtures.admin, "ADMIN"),
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });
    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("DRAFT");
  });

  it("MEMBER is rejected with FORBIDDEN, and the invoice remains DRAFT", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const result = await issueInvoice({
      actor: actorFor(fixtures, fixtures.member, "MEMBER"),
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });
    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("DRAFT");
  });

  // --- 16: cross-org / nonexistent indistinguishable --------------------------

  it("a cross-organization invoiceId and a nonexistent invoiceId both return the identical NOT_FOUND result", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const crossOrgActor = actorFor(fixtures, fixtures.orgBOwner, "OWNER");

    const crossOrgResult = await issueInvoice({
      actor: { ...crossOrgActor, organizationId: fixtures.orgB.id },
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });
    const nonexistentResult = await issueInvoice({
      actor: { ...crossOrgActor, organizationId: fixtures.orgB.id },
      invoiceId: randomUUID(),
      expectedUpdatedAt: new Date().toISOString(),
    });

    expect(crossOrgResult).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(nonexistentResult).toEqual({ ok: false, error: "NOT_FOUND" });
  });

  // --- 17: non-DRAFT rejected --------------------------------------------------

  it("a non-DRAFT invoice is rejected with NOT_DRAFT", async () => {
    const invoice = await seedDraftInvoice(fixtures, { status: "SENT" });
    const result = await issueInvoice({
      actor: actorFor(fixtures, fixtures.owner, "OWNER"),
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });
    expect(result).toEqual({ ok: false, error: "NOT_DRAFT" });
  });

  // --- 18: stale expectedUpdatedAt rejected before any render/upload work -----

  it("a stale expectedUpdatedAt is rejected before any render/upload work happens", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const staleDate = new Date(invoice.updatedAt.getTime() - 60_000).toISOString();
    let renderCalled = false;

    const result = await issueInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: staleDate },
      { render: async () => { renderCalled = true; return Buffer.from("%PDF-1.3"); } },
    );

    expect(result).toEqual({ ok: false, error: "STALE_VERSION" });
    expect(renderCalled).toBe(false);
  });

  // --- 19: concurrent edit during rendering is caught by the final guard -----

  it("an edit that commits DURING rendering is caught by the final transaction's own guard — CONFLICT, with compensation", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const expectedUpdatedAt = invoice.updatedAt.toISOString();

    const result = await issueInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt },
      {
        render: async (viewModel) => {
          // Simulate a concurrent edit committing while this render is in flight.
          await prisma.invoice.update({ where: { id: invoice.id }, data: { notes: "concurrent edit", updatedAt: new Date(invoice.updatedAt.getTime() + 5000) } });
          return renderInvoicePdfBuffer(viewModel);
        },
      },
    );

    expect(result).toEqual({ ok: false, error: "CONFLICT" });
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("DRAFT");
    expect(after.notes).toBe("concurrent edit");

    const ledger = await prisma.invoicePdfArchiveObject.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(ledger.status).toBe("CLEANED");
    expect(testStorageRead("attachments", ledger.storagePath)).toBeNull();
  });

  // --- 20-21: render/validation failures create neither ledger nor object -----

  it("a renderer failure creates neither a ledger row nor a Storage object", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const before = await prisma.invoicePdfArchiveObject.count({ where: { invoiceId: invoice.id } });

    const result = await issueInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      { render: async () => { throw new Error("simulated render failure"); } },
    );

    expect(result).toEqual({ ok: false, error: "RENDER_FAILED" });
    const after = await prisma.invoicePdfArchiveObject.count({ where: { invoiceId: invoice.id } });
    expect(after).toBe(before);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("DRAFT");
  });

  it("a PDF buffer that fails structural validation creates neither a ledger row nor a Storage object", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const result = await issueInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      { render: async () => Buffer.from("not a real pdf") },
    );
    expect(result).toEqual({ ok: false, error: "RENDER_FAILED" });
    expect(await prisma.invoicePdfArchiveObject.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });

  // --- 22: ledger-create failure performs no upload ----------------------------

  it("a ledger-creation failure (archiveId collision) performs no upload attempt", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const collidingArchiveId = randomUUID();
    // Pre-occupy the exact id the service will try to use.
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
    const result = await issueInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      {
        generateArchiveId: () => collidingArchiveId,
        upload: async (args) => {
          uploadCalled = true;
          return uploadInvoicePdfObject(args);
        },
      },
    );

    expect(result).toEqual({ ok: false, error: "FINALIZATION_FAILED" });
    expect(uploadCalled).toBe(false);

    await prisma.invoicePdfArchiveObject.delete({ where: { id: collidingArchiveId } });
  });

  // --- 23-25: upload failure / compensation -----------------------------------

  it("an upload failure attempts exact compensation and, on success, the ledger becomes CLEANED", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    let removedPath: string | null = null;

    const result = await issueInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      {
        upload: async () => ({ ok: false, reason: "upload_failed" }),
        remove: async ({ identity }) => {
          removedPath = buildInvoicePdfStoragePath(identity);
          return { ok: true };
        },
      },
    );

    expect(result).toEqual({ ok: false, error: "UPLOAD_FAILED" });
    const ledger = await prisma.invoicePdfArchiveObject.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(ledger.status).toBe("CLEANED");
    expect(ledger.cleanedAt).not.toBeNull();
    expect(removedPath).toBe(ledger.storagePath);
  });

  it("an upload adapter that throws is treated as an ambiguous UPLOAD_FAILED, and never lets the raw exception escape", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    let removeCalled = false;

    const result = await issueInvoice(
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

  it("a remove adapter that throws during compensation is converted to the bounded remove_failed category — never escapes, ledger becomes CLEANUP_PENDING with an incremented attempt count", async () => {
    const invoice = await seedDraftInvoice(fixtures);

    const result = await issueInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      {
        upload: async () => ({ ok: false, reason: "upload_failed" }),
        remove: async () => {
          throw new Error("simulated storage provider exception during removal");
        },
      },
    );

    expect(result).toEqual({ ok: false, error: "UPLOAD_FAILED" });
    const ledger = await prisma.invoicePdfArchiveObject.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(ledger.status).toBe("CLEANUP_PENDING");
    expect(ledger.cleanupAttemptCount).toBe(1);
    expect(ledger.lastCleanupFailureCategory).toBe("remove_failed");
    expect(ledger.cleanedAt).toBeNull();
  });

  it("an invalid generated archive identity performs no upload and creates no ledger row, returning FINALIZATION_FAILED", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const before = await prisma.invoicePdfArchiveObject.count({ where: { invoiceId: invoice.id } });
    let uploadCalled = false;

    const result = await issueInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      {
        generateArchiveId: () => "not-a-valid-uuid",
        upload: async (args) => {
          uploadCalled = true;
          return uploadInvoicePdfObject(args);
        },
      },
    );

    expect(result).toEqual({ ok: false, error: "FINALIZATION_FAILED" });
    expect(uploadCalled).toBe(false);
    const after = await prisma.invoicePdfArchiveObject.count({ where: { invoiceId: invoice.id } });
    expect(after).toBe(before);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("DRAFT");
  });

  it("when compensating removal also fails, the ledger becomes CLEANUP_PENDING with a bounded failure category and an incremented attempt count", async () => {
    const invoice = await seedDraftInvoice(fixtures);

    const result = await issueInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      {
        upload: async () => ({ ok: false, reason: "upload_failed" }),
        remove: async () => ({ ok: false, reason: "remove_failed" }),
      },
    );

    expect(result).toEqual({ ok: false, error: "UPLOAD_FAILED" });
    const ledger = await prisma.invoicePdfArchiveObject.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(ledger.status).toBe("CLEANUP_PENDING");
    expect(ledger.cleanupAttemptCount).toBe(1);
    expect(ledger.lastCleanupFailureCategory).toBe("remove_failed");
    expect(ledger.cleanedAt).toBeNull();
  });

  // --- 26-27: final transaction / Activity failure rolls back + compensates ---

  it("a forced Activity-write failure rolls back the Invoice/ledger transition together, then compensates the uploaded object", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    vi.mocked(createActivity).mockRejectedValueOnce(new Error("simulated activity failure"));

    const result = await issueInvoice({
      actor: actorFor(fixtures, fixtures.owner, "OWNER"),
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });

    expect(result).toEqual({ ok: false, error: "FINALIZATION_FAILED" });

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("DRAFT");
    expect(after.pdfStoragePath).toBeNull();
    expect(after.finalizedAt).toBeNull();

    const activities = await prisma.activity.findMany({ where: { entityType: "INVOICE", entityId: invoice.id, action: "STATUS_CHANGED" } });
    expect(activities).toHaveLength(0);

    const ledger = await prisma.invoicePdfArchiveObject.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(ledger.status).toBe("CLEANED");
    expect(testStorageRead("attachments", ledger.storagePath)).toBeNull();
  });

  it("a failure injected AFTER the real createActivity() write (inside the same transaction, proven to have genuinely created Activity/Notification rows there) rolls everything back together and compensates the uploaded object", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const actual = await vi.importActual<typeof import("@/lib/activity/create-activity")>("@/lib/activity/create-activity");
    let capturedNotificationIds: string[] = [];

    vi.mocked(createActivity).mockImplementationOnce(async (tx, args) => {
      const activity = await actual.createActivity(tx, args);
      capturedNotificationIds = activity.notificationIds;
      // Prove the write genuinely happened inside this same transaction —
      // not merely that it was never attempted — before forcing a
      // rollback.
      const withinTx = await tx.activity.findUniqueOrThrow({ where: { id: activity.id } });
      expect(withinTx.action).toBe("STATUS_CHANGED");
      if (activity.notificationIds.length > 0) {
        const notificationsWithinTx = await tx.notification.findMany({ where: { id: { in: activity.notificationIds } } });
        expect(notificationsWithinTx.length).toBe(activity.notificationIds.length);
      }
      throw new Error("simulated failure after the real Activity/Notification write");
    });

    const result = await issueInvoice({
      actor: actorFor(fixtures, fixtures.owner, "OWNER"),
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });

    expect(result).toEqual({ ok: false, error: "FINALIZATION_FAILED" });

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("DRAFT");

    const activities = await prisma.activity.findMany({ where: { entityType: "INVOICE", entityId: invoice.id, action: "STATUS_CHANGED" } });
    expect(activities).toHaveLength(0);

    expect(capturedNotificationIds.length).toBeGreaterThan(0);
    const survivingNotifications = await prisma.notification.findMany({ where: { id: { in: capturedNotificationIds } } });
    expect(survivingNotifications).toHaveLength(0);

    const ledger = await prisma.invoicePdfArchiveObject.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(ledger.status).toBe("CLEANED");
    expect(testStorageRead("attachments", ledger.storagePath)).toBeNull();
  });

  it("a ledger-transition invariant failure (the ledger row is no longer PENDING_UPLOAD when the final transaction runs) is classified as FINALIZATION_FAILED, never CONFLICT — full rollback, compensation, no Activity/Notification", async () => {
    const invoice = await seedDraftInvoice(fixtures);

    const result = await issueInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      {
        // Runs after the real upload succeeds and before the final
        // transaction opens — mutate the ledger row's own status away
        // from PENDING_UPLOAD, simulating a race the guarded ledger
        // transition must detect and reject as a distinct internal
        // invariant failure, never conflated with an ordinary Invoice
        // optimistic-concurrency CONFLICT.
        afterUploadBeforeFinalize: async () => {
          await prisma.invoicePdfArchiveObject.updateMany({
            where: { invoiceId: invoice.id, status: "PENDING_UPLOAD" },
            data: { status: "CLEANED", cleanedAt: new Date() },
          });
        },
      },
    );

    expect(result).toEqual({ ok: false, error: "FINALIZATION_FAILED" });

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("DRAFT");
    expect(after.finalizedAt).toBeNull();
    expect(after.pdfStoragePath).toBeNull();
    expect(after.issuerSnapshot).toBeNull();
    expect(after.recipientSnapshot).toBeNull();

    const activities = await prisma.activity.findMany({ where: { entityType: "INVOICE", entityId: invoice.id, action: "STATUS_CHANGED" } });
    expect(activities).toHaveLength(0);

    const ledger = await prisma.invoicePdfArchiveObject.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    // The compensating removal still runs (best-effort) even though the
    // row's own status update no-ops (it is no longer PENDING_UPLOAD) —
    // the object itself must still not be left behind.
    expect(testStorageRead("attachments", ledger.storagePath)).toBeNull();
  });

  it("an ordinary Invoice update-count-zero conflict (a concurrent edit/second Issue attempt) is classified as CONFLICT, distinct from a ledger-transition invariant failure", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const expectedUpdatedAt = invoice.updatedAt.toISOString();

    const result = await issueInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt },
      {
        afterUploadBeforeFinalize: async () => {
          await prisma.invoice.update({ where: { id: invoice.id }, data: { notes: "concurrent edit via afterUploadBeforeFinalize", updatedAt: new Date(invoice.updatedAt.getTime() + 5000) } });
        },
      },
    );

    expect(result).toEqual({ ok: false, error: "CONFLICT" });
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("DRAFT");
  });

  // --- 28: post-commit delivery failure never undoes finalization -------------

  it("a post-commit notification-email delivery failure never undoes the already-committed finalization", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const result = await issueInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      { deliverEmails: async () => { throw new Error("simulated provider outage"); } },
    );

    expect(result.ok).toBe(true);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("SENT");
  });

  // --- 29-30: logo resolution threading ----------------------------------------

  it("valid logo bytes and their SHA-256 match the persisted snapshot's own provenance", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const { createHash } = await import("node:crypto");
    const expectedSha = createHash("sha256").update(GENUINE_PNG_BYTES).digest("hex");

    const result = await issueInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      {
        resolveLogo: async () => ({
          provenance: { included: true, bucket: "logos", path: "organizations/x/logo/y.png", contentType: "image/png", sha256: expectedSha },
          bytes: { data: GENUINE_PNG_BYTES, contentType: "image/png" },
        }),
      },
    );

    expect(result.ok).toBe(true);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    const issuerSnapshot = after.issuerSnapshot as { logo: { included: boolean; sha256: string } };
    expect(issuerSnapshot.logo.included).toBe(true);
    expect(issuerSnapshot.logo.sha256).toBe(expectedSha);

    const stored = testStorageRead("attachments", after.pdfStoragePath!);
    expect(isPdfSignature(stored!.body)).toBe(true);
  });

  // --- logo failure must not block Issue: signature-passing-but-corrupt bytes causes a real render failure, retried once without the logo -----

  it("when the first render (with logo) fails, a no-logo retry succeeds — Invoice becomes SENT, the persisted issuer snapshot says the logo was not included (invalid_content), and the uploaded PDF is the retry's own output", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    let renderCallCount = 0;
    let secondCallSawNoLogo = false;
    const { createHash } = await import("node:crypto");
    const corruptBytes = Buffer.from("structurally-corrupt-but-signature-passing-bytes");
    const correctSha = createHash("sha256").update(corruptBytes).digest("hex");

    const result = await issueInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      {
        resolveLogo: async () => ({
          // The provenance's own SHA-256 must genuinely match the bytes —
          // this test is about the renderer itself failing on
          // structurally-corrupt (but provenance-consistent) bytes, never
          // about the unrelated provenance/byte-mismatch guard.
          provenance: { included: true, bucket: "logos", path: "organizations/x/logo/y.png", contentType: "image/png", sha256: correctSha },
          bytes: { data: corruptBytes, contentType: "image/png" },
        }),
        render: async (viewModel) => {
          renderCallCount += 1;
          if (renderCallCount === 1) {
            expect(viewModel.issuer.logoImage).not.toBeNull();
            throw new Error("simulated renderer failure decoding a structurally-corrupt logo image");
          }
          secondCallSawNoLogo = viewModel.issuer.logoImage === null;
          return renderInvoicePdfBuffer(viewModel);
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(renderCallCount).toBe(2);
    expect(secondCallSawNoLogo).toBe(true);

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("SENT");
    const issuerSnapshot = after.issuerSnapshot as { logo: { included: boolean; reason?: string } };
    expect(issuerSnapshot.logo).toEqual({ included: false, reason: "invalid_content" });

    const stored = testStorageRead("attachments", after.pdfStoragePath!);
    expect(stored).not.toBeNull();
    expect(isPdfSignature(stored!.body)).toBe(true);
  });

  it("both render attempts failing (logo included, then the no-logo retry) creates neither a ledger row nor a Storage object, and returns RENDER_FAILED", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const before = await prisma.invoicePdfArchiveObject.count({ where: { invoiceId: invoice.id } });
    let renderCallCount = 0;
    const { createHash } = await import("node:crypto");
    const corruptBytes = Buffer.from("corrupt bytes");
    const correctSha = createHash("sha256").update(corruptBytes).digest("hex");

    const result = await issueInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      {
        resolveLogo: async () => ({
          provenance: { included: true, bucket: "logos", path: "organizations/x/logo/y.png", contentType: "image/png", sha256: correctSha },
          bytes: { data: corruptBytes, contentType: "image/png" },
        }),
        render: async () => {
          renderCallCount += 1;
          throw new Error("simulated renderer failure on both attempts");
        },
      },
    );

    expect(result).toEqual({ ok: false, error: "RENDER_FAILED" });
    // Exactly two attempts: the primary (with logo) and the one no-logo
    // retry — never more, never an infinite/repeated retry loop.
    expect(renderCallCount).toBe(2);
    const after = await prisma.invoicePdfArchiveObject.count({ where: { invoiceId: invoice.id } });
    expect(after).toBe(before);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("DRAFT");
  });

  it("a render failure with no logo involved is never retried — a single attempt, RENDER_FAILED", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    let renderCallCount = 0;

    const result = await issueInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      {
        render: async () => {
          renderCallCount += 1;
          throw new Error("simulated renderer failure, no logo involved");
        },
      },
    );

    expect(result).toEqual({ ok: false, error: "RENDER_FAILED" });
    expect(renderCallCount).toBe(1);
  });

  it("no configured logo (the default fixture organization has no profile) falls back without blocking Issue", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const result = await issueInvoice({
      actor: actorFor(fixtures, fixtures.owner, "OWNER"),
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });
    expect(result.ok).toBe(true);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    const issuerSnapshot = after.issuerSnapshot as { logo: { included: boolean } };
    expect(issuerSnapshot.logo.included).toBe(false);
  });

  // --- 31: no private path leaks anywhere --------------------------------------

  it("no Storage path appears in the service result or the Activity metadata", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const result = await issueInvoice({
      actor: actorFor(fixtures, fixtures.owner, "OWNER"),
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    });
    expect(Object.keys(result)).not.toContain("pdfStoragePath");
    expect(JSON.stringify(result)).not.toContain("invoice-pdf");

    const activity = await prisma.activity.findFirstOrThrow({ where: { entityType: "INVOICE", entityId: invoice.id, action: "STATUS_CHANGED" } });
    expect(JSON.stringify(activity.metadata)).not.toContain("invoice-pdf");
    expect(JSON.stringify(activity.metadata)).not.toContain("attachments/organizations");
  });

  // --- 32: source DRAFT unchanged before the final transaction -----------------

  it("the source DRAFT row is byte-for-byte unchanged right up until the final transaction commits", async () => {
    const invoice = await seedDraftInvoice(fixtures, { notes: "original notes" });

    const result = await issueInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      {
        render: async (viewModel) => {
          const midFlight = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
          expect(midFlight.status).toBe("DRAFT");
          expect(midFlight.notes).toBe("original notes");
          expect(midFlight.pdfStoragePath).toBeNull();
          expect(midFlight.updatedAt.getTime()).toBe(invoice.updatedAt.getTime());
          return renderInvoicePdfBuffer(viewModel);
        },
      },
    );

    expect(result.ok).toBe(true);
  });

  // --- 33: true concurrency — exactly one winner -------------------------------

  it("two simultaneous Issue attempts for the same version produce exactly one finalized invoice, one REFERENCED ledger row with its object live, and every losing attempt's object fully and exactly cleaned up", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const input = {
      actor: actorFor(fixtures, fixtures.owner, "OWNER"),
      invoiceId: invoice.id,
      expectedUpdatedAt: invoice.updatedAt.toISOString(),
    };

    const [a, b] = await Promise.all([issueInvoice(input), issueInvoice(input)]);
    const results = [a, b];

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("SENT");

    const referenced = await prisma.invoicePdfArchiveObject.findMany({ where: { invoiceId: invoice.id, status: "REFERENCED" } });
    expect(referenced).toHaveLength(1);
    expect(referenced[0].storagePath).toBe(after.pdfStoragePath);

    const activities = await prisma.activity.findMany({ where: { entityType: "INVOICE", entityId: invoice.id, action: "STATUS_CHANGED" } });
    expect(activities).toHaveLength(1);

    const notifications = await prisma.notification.findMany({ where: { activityId: activities[0].id } });
    // INVOICE_STATUS_CHANGED's own rule (notification-rules.ts) fans out
    // to every OWNER/ADMIN membership in the organization; dispatch-
    // notifications.ts then excludes the actor and dedupes. This
    // fixture's own orgA membership (test/fixtures/seed.ts) is
    // owner(OWNER)/admin(ADMIN)/member(MEMBER); the actor issuing here is
    // fixtures.owner — so the only eligible, non-actor OWNER/ADMIN
    // recipient is fixtures.admin. Derived from the actual rule and
    // fixture membership, not hard-coded independently of them.
    const expectedRecipientIds = [fixtures.admin.id];
    expect(notifications.every((n) => n.activityId === activities[0].id)).toBe(true);
    expect(notifications.every((n) => n.type === "INVOICE_STATUS_CHANGED")).toBe(true);
    const recipientIds = notifications.map((n) => n.recipientId);
    expect([...recipientIds].sort()).toEqual([...expectedRecipientIds].sort());
    expect(new Set(recipientIds).size).toBe(recipientIds.length);
    // The OWNER actor never receives a self-notification for their own action.
    expect(recipientIds).not.toContain(fixtures.owner.id);

    // The losing concurrent attempt creates no second, orphaned
    // Notification fan-out anywhere in the organization for this Invoice
    // — every INVOICE_STATUS_CHANGED notification for it traces back to
    // this exact one Activity.
    const allInvoiceStatusNotifications = await prisma.notification.findMany({
      where: { organizationId: fixtures.orgA.id, entityType: "INVOICE", entityId: invoice.id, type: "INVOICE_STATUS_CHANGED" },
    });
    expect(allInvoiceStatusNotifications.map((n) => n.id).sort()).toEqual(notifications.map((n) => n.id).sort());

    // Every uploading attempt registers its own ledger row before it ever
    // uploads (pipeline step C) — this is therefore the exhaustive set of
    // every path any of this invoice's Issue attempts ever wrote to
    // Storage; there is no other path an object could exist at.
    const allLedgerRows = await prisma.invoicePdfArchiveObject.findMany({ where: { invoiceId: invoice.id } });
    expect(allLedgerRows.length).toBeGreaterThanOrEqual(1);

    let liveObjectCount = 0;
    for (const row of allLedgerRows) {
      const stored = testStorageRead("attachments", row.storagePath);
      if (row.status === "REFERENCED") {
        expect(stored).not.toBeNull();
        expect(isPdfSignature(stored!.body)).toBe(true);
        liveObjectCount += 1;
      } else {
        // Normal TEST_MODE removal always succeeds — in this ordinary
        // (non-fault-injected) concurrency scenario every losing
        // attempt's compensation reaches a fully confirmed CLEANED
        // state, never left discoverable at CLEANUP_PENDING or (worse)
        // still PENDING_UPLOAD.
        expect(row.status).toBe("CLEANED");
        expect(stored).toBeNull();
      }
    }
    // Exactly one live PDF object exists for this invoice across every
    // attempt — the REFERENCED row's own object, and nothing else.
    expect(liveObjectCount).toBe(1);
  });

  // --- 34: a real crash in the exact post-upload/pre-transaction window leaves a discoverable PENDING_UPLOAD row -----

  it("a real process crash simulated at the exact post-upload/pre-transaction boundary — via issueInvoice()'s own afterUploadBeforeFinalize hook, deliberately uncaught — leaves the ledger row discoverable at PENDING_UPLOAD with its uploaded object still present, the source Invoice untouched, and no Activity/Notification", async () => {
    const invoice = await seedDraftInvoice(fixtures, { notes: "pre-crash notes" });
    const CRASH_MARKER = new Error("simulated process crash — deliberately not caught by issueInvoice() itself");

    // This proves the REAL pipeline's own ordering, not a hand-seeded row:
    // the hook only ever runs after a real upload has already succeeded,
    // and its own throw is never wrapped in a try/catch by issue-invoice.ts
    // — it propagates straight out of issueInvoice() itself, exactly like
    // the process actually disappearing before any of the service's own
    // ordinary error handling (or compensation) could run.
    await expect(
      issueInvoice(
        { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
        { afterUploadBeforeFinalize: () => { throw CRASH_MARKER; } },
      ),
    ).rejects.toThrow(CRASH_MARKER);

    // The ledger row this exact attempt created — loaded once, up front,
    // so both the proof below and the `finally` cleanup act on the exact
    // same row regardless of which assertion (if any) fails.
    const ledger = await prisma.invoicePdfArchiveObject.findFirstOrThrow({ where: { invoiceId: invoice.id } });

    try {
      // The final transaction never ran — the source Invoice is
      // completely untouched.
      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(after.status).toBe("DRAFT");
      expect(after.notes).toBe("pre-crash notes");
      expect(after.finalizedAt).toBeNull();
      expect(after.pdfGeneratedAt).toBeNull();
      expect(after.pdfStoragePath).toBeNull();
      expect(after.issuerSnapshot).toBeNull();
      expect(after.recipientSnapshot).toBeNull();

      const activities = await prisma.activity.findMany({ where: { entityType: "INVOICE", entityId: invoice.id, action: "STATUS_CHANGED" } });
      expect(activities).toHaveLength(0);
      const notifications = await prisma.notification.findMany({ where: { organizationId: fixtures.orgA.id, activity: { entityId: invoice.id } } });
      expect(notifications).toHaveLength(0);

      // This exact attempt's own ledger row is still PENDING_UPLOAD — no
      // compensation ever ran, because the crash happened before
      // issueInvoice() could reach any of its own catch/compensation
      // logic.
      expect(ledger.status).toBe("PENDING_UPLOAD");

      // The exact uploaded PDF object is still present, untouched.
      const stored = testStorageRead("attachments", ledger.storagePath);
      expect(stored).not.toBeNull();
      expect(isPdfSignature(stored!.body)).toBe(true);

      // The same query shape the future Slice 3d reconciliation worker
      // will use discovers this exact row.
      const discoverable = await prisma.invoicePdfArchiveObject.findMany({
        where: { status: { in: ["PENDING_UPLOAD", "CLEANUP_PENDING"] } },
      });
      expect(discoverable.some((row) => row.id === ledger.id)).toBe(true);
    } finally {
      // Test-hygiene cleanup, not the real Issue pipeline's own
      // compensation (this crash is specifically the scenario where that
      // never runs) — runs even if a proof assertion above fails, and
      // removes the exact Storage object BEFORE the ledger row, so a
      // failed removal never leaves an untracked object with no ledger
      // evidence pointing at it.
      const identity = { organizationId: ledger.organizationId, invoiceId: invoice.id, documentVersion: ledger.documentVersion, archiveId: ledger.id };
      const removal = await removeInvoicePdfObject({ identity });
      expect(removal).toEqual({ ok: true });
      expect(testStorageRead("attachments", ledger.storagePath)).toBeNull();

      await prisma.invoicePdfArchiveObject.delete({ where: { id: ledger.id } });
    }
  });
});

describe("issueInvoiceAction — full-stack wiring (Server Action -> service)", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterAll(async () => {
    await prisma.invoicePdfArchiveObject.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await cleanupTestData(fixtures);
  });

  it("OWNER can issue via the real Server Action, and the public result contains no private path", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await issueInvoiceAction(invoice.id, invoice.updatedAt.toISOString());
    resetAuthMock();

    expect(result.ok).toBe(true);
    expect(Object.keys(result)).toEqual(["ok", "finalizedAt"]);

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("SENT");
  });

  it("ADMIN calling the real Server Action is rejected with FORBIDDEN", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    actAs(fixtures.admin, fixtures.orgA.id);
    const result = await issueInvoiceAction(invoice.id, invoice.updatedAt.toISOString());
    resetAuthMock();

    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("DRAFT");
  });

  it("MEMBER calling the real Server Action is rejected with FORBIDDEN", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    actAs(fixtures.member, fixtures.orgA.id);
    const result = await issueInvoiceAction(invoice.id, invoice.updatedAt.toISOString());
    resetAuthMock();

    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
  });
});

describe("InvoicePdfArchiveObject — Organization/Invoice FK delete behavior", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterAll(async () => {
    await prisma.invoicePdfArchiveObject.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await cleanupTestData(fixtures);
  });

  it("deleting a DRAFT Invoice sets its ledger row's invoiceId to null — the ledger row itself is never deleted", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const archiveId = randomUUID();
    const path = buildInvoicePdfStoragePath({ organizationId: fixtures.orgA.id, invoiceId: invoice.id, documentVersion: 1, archiveId });
    await prisma.invoicePdfArchiveObject.create({
      data: { id: archiveId, organizationId: fixtures.orgA.id, invoiceId: invoice.id, documentVersion: 1, storagePath: path, status: "PENDING_UPLOAD" },
    });

    await prisma.invoice.delete({ where: { id: invoice.id } });

    const ledger = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: archiveId } });
    expect(ledger.invoiceId).toBeNull();
    expect(ledger.organizationId).toBe(fixtures.orgA.id);

    await prisma.invoicePdfArchiveObject.delete({ where: { id: archiveId } });
  });

  it("deleting an Organization while a ledger row still references it is rejected by the database (ON DELETE RESTRICT) — never silently cascades away the durable evidence trail", async () => {
    const throwawayOrg = await prisma.organization.create({
      data: { name: `restrict-fk-test-${fixtures.runId}`, slug: `restrict-fk-test-${fixtures.runId}-${randomUUID().slice(0, 8)}` },
    });
    const archiveId = randomUUID();
    const path = buildInvoicePdfStoragePath({ organizationId: throwawayOrg.id, invoiceId: randomUUID(), documentVersion: 1, archiveId });
    await prisma.invoicePdfArchiveObject.create({
      data: { id: archiveId, organizationId: throwawayOrg.id, documentVersion: 1, storagePath: path, status: "PENDING_UPLOAD" },
    });

    await expect(prisma.organization.delete({ where: { id: throwawayOrg.id } })).rejects.toThrow();

    // The ledger row must have survived the rejected delete attempt.
    const ledger = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: archiveId } });
    expect(ledger.organizationId).toBe(throwawayOrg.id);

    // Clean up in FK-safe order (the ledger row must go first).
    await prisma.invoicePdfArchiveObject.delete({ where: { id: archiveId } });
    await prisma.organization.delete({ where: { id: throwawayOrg.id } });
  });
});
