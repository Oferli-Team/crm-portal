import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import type { Role } from "@/generated/prisma/enums";
import { ATTACHMENTS_BUCKET } from "@/lib/storage/attachments-config";

/**
 * Bounded Archival Reconciliation/Cleanup — the producer/finalizer vs.
 * reconciliation-claim coordination proofs for issueInvoice(). Runs
 * against the real repository database harness (PGlite), mirroring
 * test/integration/invoices/issue.test.ts's own structure and TEST_MODE
 * conventions exactly.
 */

const ORIGINAL_TEST_MODE = process.env.TEST_MODE;
process.env.TEST_MODE = "1";

const { issueInvoice } = await import("@/lib/invoices/pdf/issue-invoice");
const { compensateArchiveUpload } = await import("@/lib/invoices/pdf/archive-compensation");
const { buildInvoicePdfStoragePath } = await import("@/lib/invoices/pdf/storage");
const { reconcileInvoicePdfArchiveObjects } = await import("@/lib/invoices/pdf/reconcile-archive-objects");
const { testStorageRead } = await import("@/lib/storage/test-storage");

afterAll(() => {
  if (ORIGINAL_TEST_MODE === undefined) delete process.env.TEST_MODE;
  else process.env.TEST_MODE = ORIGINAL_TEST_MODE;
});

const INVOICE_NUMBER_PREFIX = "INV-ISSUE-COORD";

async function seedDraftInvoice(fixtures: TestFixtures) {
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
    },
  });
}

function actorFor(fixtures: TestFixtures, user: { id: string; name: string }, role: Role) {
  return { organizationId: fixtures.orgA.id, userId: user.id, userName: user.name, role };
}

describe("issueInvoice — reconciliation coordination", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterAll(async () => {
    await prisma.invoicePdfArchiveObject.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await cleanupTestData(fixtures);
  });

  it("finalization wins: after a normal successful Issue, the row is REFERENCED and reconciliation never claims it", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const result = await issueInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      { render: async () => Buffer.from("%PDF-1.3") },
    );
    expect(result.ok).toBe(true);

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("SENT");
    expect(after.pdfStoragePath).not.toBeNull();

    const ledger = await prisma.invoicePdfArchiveObject.findFirstOrThrow({ where: { storagePath: after.pdfStoragePath! } });
    expect(ledger.status).toBe("REFERENCED");

    const summary = await reconcileInvoicePdfArchiveObjects({ now: new Date() });
    void summary;

    const ledgerAfter = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: ledger.id } });
    expect(ledgerAfter).toEqual(ledger); // structurally excluded — never claimed, never touched
  });

  it("reconciliation claim wins: injected mid-flight (between upload and the final transaction), the whole Invoice+ledger transaction rolls back", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    let capturedArchiveId = "";

    const result = await issueInvoice(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
      {
        render: async () => Buffer.from("%PDF-1.3"),
        generateArchiveId: () => {
          capturedArchiveId = randomUUID();
          return capturedArchiveId;
        },
        afterUploadBeforeFinalize: async () => {
          // Simulate reconciliation claiming this exact row right between
          // upload succeeding and Issue's own final transaction opening.
          await prisma.invoicePdfArchiveObject.update({
            where: { id: capturedArchiveId },
            data: { cleanupLockedAt: new Date(), cleanupClaimToken: randomUUID() },
          });
        },
      },
    );

    expect(result).toEqual({ ok: false, error: "FINALIZATION_FAILED" });

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("DRAFT");
    expect(after.pdfStoragePath).toBeNull();
    expect(after.finalizedAt).toBeNull();
    expect(after.issuerSnapshot).toBeNull();
    expect(after.recipientSnapshot).toBeNull();

    // Issue's own post-failure compensation ran (outside the rolled-back
    // transaction) but its guarded update also matched zero rows — the
    // row is left exactly as reconciliation's own claim left it, not
    // silently reset.
    const ledger = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: capturedArchiveId } });
    expect(ledger.status).toBe("PENDING_UPLOAD");
    expect(ledger.cleanupClaimToken).not.toBeNull();

    await prisma.invoicePdfArchiveObject.delete({ where: { id: capturedArchiveId } });
  });

  it("compensation cannot overwrite a row the reconciliation worker currently holds claimed", async () => {
    const archiveId = randomUUID();
    const identity = { organizationId: fixtures.orgA.id, invoiceId: fixtures.invoice.id, documentVersion: 1, archiveId };
    const path = buildInvoicePdfStoragePath(identity);
    const claimToken = randomUUID();

    await prisma.invoicePdfArchiveObject.create({
      data: {
        id: archiveId,
        organizationId: fixtures.orgA.id,
        invoiceId: null,
        documentVersion: 1,
        storagePath: path,
        status: "PENDING_UPLOAD",
        cleanupLockedAt: new Date(),
        cleanupClaimToken: claimToken,
      },
    });

    const removeSpy = vi.fn(async () => ({ ok: true as const }));
    try {
      await compensateArchiveUpload({ remove: removeSpy }, archiveId, identity, new Date());

      const after = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: archiveId } });
      expect(after.status).toBe("PENDING_UPLOAD"); // unchanged — compensation's own updateMany matched zero rows
      expect(after.cleanupClaimToken).toBe(claimToken); // still reconciliation's own claim, never overwritten
    } finally {
      await prisma.invoicePdfArchiveObject.delete({ where: { id: archiveId } });
    }
  });

  it("pre-upload ownership loss: when the ownership recheck finds no matching row, deps.upload is never called and FINALIZATION_FAILED is returned", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const uploadSpy = vi.fn(async () => ({ ok: true as const }));
    // Forces the pre-upload ownership recheck's own findFirst to resolve
    // null exactly once — deterministically reproducing "the row is no
    // longer owned by this attempt" regardless of which real-world cause
    // (a reconciliation claim, or anything else) would produce it.
    const findFirstSpy = vi.spyOn(prisma.invoicePdfArchiveObject, "findFirst").mockResolvedValueOnce(null);
    try {
      const result = await issueInvoice(
        { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
        { render: async () => Buffer.from("%PDF-1.3"), upload: uploadSpy },
      );

      expect(result).toEqual({ ok: false, error: "FINALIZATION_FAILED" });
      expect(uploadSpy).not.toHaveBeenCalled();

      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(after.status).toBe("DRAFT");
      expect(after.pdfStoragePath).toBeNull();
    } finally {
      findFirstSpy.mockRestore();
    }
  });

  it("pre-upload ownership query failure: when the ownership recheck rejects, deps.upload is never called, the bounded FINALIZATION_FAILED result is returned, and the PENDING_UPLOAD ledger row survives untouched", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const uploadSpy = vi.fn(async () => ({ ok: true as const }));
    let capturedArchiveId = "";
    // A rejected (not merely null) ownership recheck must be bounded exactly
    // like the null-result case above — this is a distinct scenario, kept
    // as its own test rather than folded into the one above.
    const findFirstSpy = vi
      .spyOn(prisma.invoicePdfArchiveObject, "findFirst")
      .mockRejectedValueOnce(new Error("synthetic ownership-query failure"));
    try {
      const result = await issueInvoice(
        { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString() },
        {
          render: async () => Buffer.from("%PDF-1.3"),
          upload: uploadSpy,
          generateArchiveId: () => {
            capturedArchiveId = randomUUID();
            return capturedArchiveId;
          },
        },
      );

      expect(result).toEqual({ ok: false, error: "FINALIZATION_FAILED" });
      expect(uploadSpy).not.toHaveBeenCalled();

      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(after.status).toBe("DRAFT");
      expect(after.pdfStoragePath).toBeNull();
      expect(after.finalizedAt).toBeNull();
      expect(after.issuerSnapshot).toBeNull();
      expect(after.recipientSnapshot).toBeNull();

      const ledger = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: capturedArchiveId } });
      expect(ledger.status).toBe("PENDING_UPLOAD");
      expect(ledger.cleanupLockedAt).toBeNull();
      expect(ledger.cleanupClaimToken).toBeNull();
      expect(ledger.referencedAt).toBeNull();
      expect(ledger.cleanedAt).toBeNull();

      const identity = {
        organizationId: fixtures.orgA.id,
        invoiceId: invoice.id,
        documentVersion: invoice.documentVersion,
        archiveId: capturedArchiveId,
      };
      const path = buildInvoicePdfStoragePath(identity);
      expect(testStorageRead(ATTACHMENTS_BUCKET, path)).toBeNull();
    } finally {
      findFirstSpy.mockRestore();
      if (capturedArchiveId) await prisma.invoicePdfArchiveObject.delete({ where: { id: capturedArchiveId } });
    }
  });
});
