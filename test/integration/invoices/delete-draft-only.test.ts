import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { deleteInvoiceAction } from "@/app/(dashboard)/invoices/actions";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { resetStorageMock, removedPaths } from "../../support/storage-mock";
import type { InvoiceStatusValue } from "@/lib/validation/invoice";

const INVOICE_NUMBER_PREFIX = "INV-DELETE";

async function seedInvoiceAt(fixtures: TestFixtures, status: InvoiceStatusValue) {
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}-${randomUUID().slice(0, 8)}`,
      status,
      amount: "100.00",
      subtotal: "100.00",
      discountAmount: "0.00",
      taxAmount: "0.00",
      projectId: fixtures.project.id,
      clientId: fixtures.clientA.id,
      organizationId: fixtures.orgA.id,
    },
  });
  const attachmentId = randomUUID();
  const storagePath = `organizations/${fixtures.orgA.id}/INVOICE/${invoice.id}/${attachmentId}/file.pdf`;
  await prisma.attachment.create({
    data: {
      id: attachmentId,
      organizationId: fixtures.orgA.id,
      uploadedById: fixtures.owner.id,
      entityType: "INVOICE",
      entityId: invoice.id,
      storageBucket: "attachments",
      storagePath,
      originalName: "file.pdf",
      mimeType: "application/pdf",
      sizeBytes: 512,
    },
  });
  return { invoice, storagePath };
}

describe("deleteInvoiceAction — DRAFT-only restriction", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(() => {
    resetStorageMock();
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await cleanupTestData(fixtures);
  });

  it("DRAFT deletes successfully: DB row gone, DELETED Activity written, Attachment DB row + Storage object both removed", async () => {
    const { invoice, storagePath } = await seedInvoiceAt(fixtures, "DRAFT");
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await deleteInvoiceAction(invoice.id);
    resetAuthMock();

    expect(result).toEqual({ ok: true });

    const gone = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(gone).toBeNull();

    const activity = await prisma.activity.findFirstOrThrow({ where: { entityId: invoice.id, action: "DELETED" } });
    expect(activity.metadata).toMatchObject({ status: "DRAFT" });

    const attachment = await prisma.attachment.findFirst({ where: { entityId: invoice.id } });
    expect(attachment).toBeNull();

    expect(removedPaths).toContain(storagePath);
  });

  it("a non-DRAFT invoice is never deleted, zero Storage calls, no Activity", async () => {
    const { invoice, storagePath } = await seedInvoiceAt(fixtures, "SENT");
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await deleteInvoiceAction(invoice.id);
    resetAuthMock();

    expect(result).toEqual({ ok: false, error: "NOT_FOUND_OR_NOT_DRAFT" });

    const stillThere = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(stillThere.status).toBe("SENT");

    const activityCount = await prisma.activity.count({ where: { entityId: invoice.id, action: "DELETED" } });
    expect(activityCount).toBe(0);

    const attachment = await prisma.attachment.findFirst({ where: { entityId: invoice.id } });
    expect(attachment).not.toBeNull();
    expect(removedPaths).not.toContain(storagePath);
  });

  it("every other non-DRAFT status is also protected", async () => {
    for (const status of ["OVERDUE", "PAID", "CANCELLED"] as const) {
      const { invoice } = await seedInvoiceAt(fixtures, status);
      actAs(fixtures.owner, fixtures.orgA.id);
      const result = await deleteInvoiceAction(invoice.id);
      resetAuthMock();

      expect(result).toEqual({ ok: false, error: "NOT_FOUND_OR_NOT_DRAFT" });
      const stillThere = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(stillThere.status).toBe(status);
    }
  });

  it("a race — the invoice transitions off DRAFT between page load and the delete click — is a controlled no-op, zero Storage calls", async () => {
    const { invoice, storagePath } = await seedInvoiceAt(fixtures, "DRAFT");
    // Simulate a concurrent lifecycle change that already landed before
    // the guarded delete runs.
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "SENT" } });

    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await deleteInvoiceAction(invoice.id);
    resetAuthMock();

    expect(result).toEqual({ ok: false, error: "NOT_FOUND_OR_NOT_DRAFT" });
    expect(removedPaths).not.toContain(storagePath);
  });

  it("a nonexistent invoice id is a controlled no-op", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await deleteInvoiceAction(randomUUID());
    resetAuthMock();
    expect(result).toEqual({ ok: false, error: "NOT_FOUND_OR_NOT_DRAFT" });
  });
});
