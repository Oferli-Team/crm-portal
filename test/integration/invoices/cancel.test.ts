import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { changeInvoiceStatusAction } from "@/app/(dashboard)/invoices/[id]/status-actions";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import type { InvoiceStatusValue } from "@/lib/validation/invoice";

/**
 * Cancel is the same lifecycle transition to CANCELLED — never a separate
 * business implementation (docs/invoicing-architecture.md §3.2). Reuses
 * changeInvoiceStatusAction exactly like every other transition button.
 */
const INVOICE_NUMBER_PREFIX = "INV-CANCEL";

async function seedInvoiceAt(fixtures: TestFixtures, status: InvoiceStatusValue) {
  return prisma.invoice.create({
    data: {
      invoiceNumber: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}-${randomUUID().slice(0, 8)}`,
      status,
      amount: "100.00",
      subtotal: "100.00",
      discountAmount: "0.00",
      taxAmount: "0.00",
      paidAt: status === "PAID" ? new Date() : null,
      projectId: fixtures.project.id,
      clientId: fixtures.clientA.id,
      organizationId: fixtures.orgA.id,
    },
  });
}

describe("Cancel — via changeInvoiceStatusAction(id, \"CANCELLED\")", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await cleanupTestData(fixtures);
  });

  it("SENT can be cancelled", async () => {
    const invoice = await seedInvoiceAt(fixtures, "SENT");
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await changeInvoiceStatusAction(invoice.id, "CANCELLED");
    resetAuthMock();

    expect(result).toEqual({ ok: true });
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("CANCELLED");
  });

  it("OVERDUE can be cancelled", async () => {
    const invoice = await seedInvoiceAt(fixtures, "OVERDUE");
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await changeInvoiceStatusAction(invoice.id, "CANCELLED");
    resetAuthMock();

    expect(result).toEqual({ ok: true });
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("CANCELLED");
  });

  it("PAID cannot be cancelled directly", async () => {
    const invoice = await seedInvoiceAt(fixtures, "PAID");
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await changeInvoiceStatusAction(invoice.id, "CANCELLED");
    resetAuthMock();

    expect(result).toEqual({ ok: false, error: "FORBIDDEN_TRANSITION" });
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("PAID");
  });

  it("DRAFT cannot be cancelled — abandoning an unissued draft is a delete, not a cancellation", async () => {
    const invoice = await seedInvoiceAt(fixtures, "DRAFT");
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await changeInvoiceStatusAction(invoice.id, "CANCELLED");
    resetAuthMock();

    expect(result).toEqual({ ok: false, error: "FORBIDDEN_TRANSITION" });
  });

  it("CANCELLED cannot be cancelled again — terminal", async () => {
    const invoice = await seedInvoiceAt(fixtures, "CANCELLED");
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await changeInvoiceStatusAction(invoice.id, "CANCELLED");
    resetAuthMock();

    expect(result).toEqual({ ok: false, error: "FORBIDDEN_TRANSITION" });
  });

  it("a race — two concurrent Cancel attempts on the same SENT invoice — exactly one succeeds", async () => {
    const invoice = await seedInvoiceAt(fixtures, "SENT");
    actAs(fixtures.owner, fixtures.orgA.id);
    const [a, b] = await Promise.all([
      changeInvoiceStatusAction(invoice.id, "CANCELLED"),
      changeInvoiceStatusAction(invoice.id, "CANCELLED"),
    ]);
    resetAuthMock();

    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
  });
});
