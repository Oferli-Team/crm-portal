import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { changeInvoiceStatusAction } from "@/app/(dashboard)/invoices/[id]/status-actions";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";

const INVOICE_NUMBER_PREFIX = "INV-INVALIDSTATUS";

describe("changeInvoiceStatusAction — runtime target-status validation", () => {
  let fixtures: TestFixtures;
  let invoice: { id: string; status: string; updatedAt: Date };

  beforeAll(async () => {
    fixtures = await seedTestData();
    invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}`,
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
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await cleanupTestData(fixtures);
  });

  it("a forged/unknown string value is rejected with INVALID_STATUS, before any DB access, zero writes", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });

    const result = await changeInvoiceStatusAction(invoice.id, "NOT_A_REAL_STATUS");
    resetAuthMock();

    expect(result).toEqual({ ok: false, error: "INVALID_STATUS" });

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe(before.status);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());

    const activityCount = await prisma.activity.count({ where: { entityId: invoice.id } });
    expect(activityCount).toBe(0);
    const notificationCount = await prisma.notification.count({ where: { entityId: invoice.id } });
    expect(notificationCount).toBe(0);
  });

  it("an empty string is rejected the same way", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await changeInvoiceStatusAction(invoice.id, "");
    resetAuthMock();
    expect(result).toEqual({ ok: false, error: "INVALID_STATUS" });
  });

  it("a lowercase version of a real status is rejected — no case-insensitive matching", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await changeInvoiceStatusAction(invoice.id, "paid");
    resetAuthMock();
    expect(result).toEqual({ ok: false, error: "INVALID_STATUS" });
  });
});
