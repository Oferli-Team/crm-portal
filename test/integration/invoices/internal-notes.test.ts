import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { updateInvoiceInternalNotesAction } from "@/app/(dashboard)/invoices/[id]/internal-notes-actions";
import { INVOICE_NOTES_MAX_LENGTH } from "@/lib/validation/invoice";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import type { InvoiceStatusValue } from "@/lib/validation/invoice";

const INVOICE_NUMBER_PREFIX = "INV-INTERNALNOTES";

async function seedInvoiceAt(fixtures: TestFixtures, status: InvoiceStatusValue, internalNotes: string | null = null) {
  return prisma.invoice.create({
    data: {
      invoiceNumber: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}-${randomUUID().slice(0, 8)}`,
      status,
      amount: "100.00",
      subtotal: "100.00",
      discountAmount: "0.00",
      taxAmount: "0.00",
      internalNotes,
      projectId: fixtures.project.id,
      clientId: fixtures.clientA.id,
      organizationId: fixtures.orgA.id,
    },
  });
}

describe("updateInvoiceInternalNotesAction — editable in every status", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await cleanupTestData(fixtures);
  });

  for (const status of ["DRAFT", "SENT", "OVERDUE", "PAID", "CANCELLED"] as const) {
    it(`can be updated while ${status}`, async () => {
      const invoice = await seedInvoiceAt(fixtures, status);
      actAs(fixtures.owner, fixtures.orgA.id);
      const result = await updateInvoiceInternalNotesAction(invoice.id, "A private note");
      resetAuthMock();

      expect(result).toEqual({ ok: true });
      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(after.internalNotes).toBe("A private note");
    });
  }

  it("trims whitespace and normalizes empty to null", async () => {
    const invoice = await seedInvoiceAt(fixtures, "DRAFT", "old");
    actAs(fixtures.owner, fixtures.orgA.id);
    await updateInvoiceInternalNotesAction(invoice.id, "   ");
    resetAuthMock();

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.internalNotes).toBeNull();
  });

  it("rejects a value over the 10,000-character cap, unchanged persisted value", async () => {
    const invoice = await seedInvoiceAt(fixtures, "DRAFT", "original");
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await updateInvoiceInternalNotesAction(invoice.id, "x".repeat(INVOICE_NOTES_MAX_LENGTH + 1));
    resetAuthMock();

    expect(result).toEqual({ ok: false, error: "TOO_LONG" });
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.internalNotes).toBe("original");
  });

  it("a no-op (identical value) creates no Activity", async () => {
    const invoice = await seedInvoiceAt(fixtures, "SENT", "same note");
    actAs(fixtures.owner, fixtures.orgA.id);
    await updateInvoiceInternalNotesAction(invoice.id, "same note");
    resetAuthMock();

    const activityCount = await prisma.activity.count({ where: { entityId: invoice.id, action: "UPDATED" } });
    expect(activityCount).toBe(0);
  });

  it("a real change writes UPDATED Activity with changedFields: ['internalNotes'] only, no value, no notification", async () => {
    const invoice = await seedInvoiceAt(fixtures, "SENT", "old note");
    actAs(fixtures.owner, fixtures.orgA.id);
    await updateInvoiceInternalNotesAction(invoice.id, "brand new secret content");
    resetAuthMock();

    const activity = await prisma.activity.findFirstOrThrow({ where: { entityId: invoice.id, action: "UPDATED" } });
    expect(activity.metadata).toMatchObject({ changedFields: ["internalNotes"] });
    expect(JSON.stringify(activity.metadata)).not.toContain("secret content");

    const notificationCount = await prisma.notification.count({ where: { activityId: activity.id } });
    expect(notificationCount).toBe(0);
  });

  it("a nonexistent invoice id is a controlled NOT_FOUND", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await updateInvoiceInternalNotesAction(randomUUID(), "x");
    resetAuthMock();
    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
  });

  it("a cross-organization invoice id is NOT_FOUND, never leaked", async () => {
    const invoice = await seedInvoiceAt(fixtures, "SENT");
    actAs(fixtures.orgBOwner, fixtures.orgB.id);
    const result = await updateInvoiceInternalNotesAction(invoice.id, "x");
    resetAuthMock();
    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
  });
});
