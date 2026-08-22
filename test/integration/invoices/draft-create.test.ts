import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createInvoiceAction } from "@/app/(dashboard)/invoices/new/actions";
import { encodeInvoiceLineItemsFormValue } from "@/lib/invoices/line-items-form";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { RedirectSignal } from "../../support/navigation-mock";

const INVOICE_NUMBER_PREFIX = "INV-DCREATE";

function uniqueInvoiceNumber(runId: string): string {
  return `${INVOICE_NUMBER_PREFIX}-${runId}-${randomUUID().slice(0, 8)}`;
}

function baseFields(overrides: Record<string, string> = {}) {
  return {
    mode: "flat",
    amount: "100.00",
    lineItems: "",
    currency: "USD",
    issueDate: "2026-08-16",
    dueDate: "",
    notes: "",
    internalNotes: "",
    discountType: "NONE",
    discountValue: "",
    taxRatePercent: "",
    taxLabel: "TAX",
    ...overrides,
  };
}

function buildFormData(invoiceNumber: string, projectId: string, overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("invoiceNumber", invoiceNumber);
  fd.set("projectId", projectId);
  for (const [key, value] of Object.entries(baseFields(overrides))) fd.set(key, value);
  return fd;
}

async function expectRedirect(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(RedirectSignal);
}

describe("createInvoiceAction — DRAFT creation, flat and itemized", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await cleanupTestData(fixtures);
  });

  it("flat: forces DRAFT, writes the server-computed total, no line items", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const invoiceNumber = uniqueInvoiceNumber(fixtures.runId);

    await expectRedirect(
      createInvoiceAction({ error: null }, buildFormData(invoiceNumber, fixtures.project.id, { amount: "250.00" })),
    );
    resetAuthMock();

    const created = await prisma.invoice.findUniqueOrThrow({
      where: { organizationId_invoiceNumber: { organizationId: fixtures.orgA.id, invoiceNumber } },
      include: { lineItems: true },
    });
    expect(created.status).toBe("DRAFT");
    expect(created.paidAt).toBeNull();
    expect(created.amount.toFixed(2)).toBe("250.00");
    expect(created.lineItems).toEqual([]);
  });

  it("itemized: creates ordered InvoiceLineItem rows and a server-recomputed total", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const invoiceNumber = uniqueInvoiceNumber(fixtures.runId);
    const lineItems = encodeInvoiceLineItemsFormValue([
      { description: "Design work", quantity: "10", unitPrice: "85.00" },
      { description: "Hosting", quantity: "1", unitPrice: "29.99" },
    ]);

    await expectRedirect(
      createInvoiceAction({ error: null }, buildFormData(invoiceNumber, fixtures.project.id, { mode: "itemized", lineItems })),
    );
    resetAuthMock();

    const created = await prisma.invoice.findUniqueOrThrow({
      where: { organizationId_invoiceNumber: { organizationId: fixtures.orgA.id, invoiceNumber } },
      include: { lineItems: { orderBy: { position: "asc" } } },
    });
    expect(created.status).toBe("DRAFT");
    expect(created.lineItems).toHaveLength(2);
    expect(created.lineItems[0]).toMatchObject({ description: "Design work", position: 0 });
    expect(created.lineItems[1]).toMatchObject({ description: "Hosting", position: 1 });
    expect(created.subtotal?.toFixed(2)).toBe("879.99"); // 10*85 + 29.99
    expect(created.amount.toFixed(2)).toBe("879.99");
  });

  it("applies discount and tax server-side, matching calculateInvoiceTotals()'s own worked example", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const invoiceNumber = uniqueInvoiceNumber(fixtures.runId);
    const lineItems = encodeInvoiceLineItemsFormValue([
      { description: "Design work", quantity: "10.5", unitPrice: "85.00" },
      { description: "Hosting", quantity: "1", unitPrice: "29.99" },
    ]);

    await expectRedirect(
      createInvoiceAction(
        { error: null },
        buildFormData(invoiceNumber, fixtures.project.id, {
          mode: "itemized",
          lineItems,
          discountType: "PERCENTAGE",
          discountValue: "10",
          taxRatePercent: "8.25",
        }),
      ),
    );
    resetAuthMock();

    const created = await prisma.invoice.findUniqueOrThrow({
      where: { organizationId_invoiceNumber: { organizationId: fixtures.orgA.id, invoiceNumber } },
    });
    expect(created.subtotal?.toFixed(2)).toBe("922.49");
    expect(created.discountAmount?.toFixed(2)).toBe("92.25");
    expect(created.taxAmount?.toFixed(2)).toBe("68.49");
    expect(created.amount.toFixed(2)).toBe("898.73");
  });

  it("rejects a tampered/invalid line item — no invoice is created", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const invoiceNumber = uniqueInvoiceNumber(fixtures.runId);
    const lineItems = encodeInvoiceLineItemsFormValue([{ description: "Bad", quantity: "-1", unitPrice: "10.00" }]);

    const result = await createInvoiceAction(
      { error: null },
      buildFormData(invoiceNumber, fixtures.project.id, { mode: "itemized", lineItems }),
    );
    resetAuthMock();

    expect(result.error).toBeNull();
    expect(result.lineItemErrors?.[0]?.quantity).toBeTruthy();
    const created = await prisma.invoice.findFirst({ where: { invoiceNumber } });
    expect(created).toBeNull();
  });

  it("writes CREATED Activity metadata with the correct line-item count and never a description/quantity/unitPrice value", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const invoiceNumber = uniqueInvoiceNumber(fixtures.runId);
    const lineItems = encodeInvoiceLineItemsFormValue([
      { description: "Secret line description", quantity: "1", unitPrice: "10.00" },
    ]);

    await expectRedirect(
      createInvoiceAction({ error: null }, buildFormData(invoiceNumber, fixtures.project.id, { mode: "itemized", lineItems })),
    );
    resetAuthMock();

    const created = await prisma.invoice.findUniqueOrThrow({
      where: { organizationId_invoiceNumber: { organizationId: fixtures.orgA.id, invoiceNumber } },
    });
    const activity = await prisma.activity.findFirstOrThrow({
      where: { entityId: created.id, action: "CREATED" },
    });
    const metadata = activity.metadata as Record<string, unknown>;
    expect(metadata.lineItemCount).toBe(1);
    expect(metadata.status).toBe("DRAFT");
    expect(JSON.stringify(metadata)).not.toContain("Secret line description");

    // No CREATED notification rule exists for INVOICE.
    const notifications = await prisma.notification.count({ where: { activityId: activity.id } });
    expect(notifications).toBe(0);
  });

  it("flat mode ignores an irrelevant lineItems payload — never creates line items even if one is submitted", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const invoiceNumber = uniqueInvoiceNumber(fixtures.runId);
    const lineItems = encodeInvoiceLineItemsFormValue([{ description: "Ignored", quantity: "1", unitPrice: "1.00" }]);

    await expectRedirect(
      createInvoiceAction({ error: null }, buildFormData(invoiceNumber, fixtures.project.id, { mode: "flat", lineItems })),
    );
    resetAuthMock();

    const created = await prisma.invoice.findUniqueOrThrow({
      where: { organizationId_invoiceNumber: { organizationId: fixtures.orgA.id, invoiceNumber } },
      include: { lineItems: true },
    });
    expect(created.lineItems).toEqual([]);
  });

  it("an invalid mode value creates no Invoice and no Activity", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const invoiceNumber = uniqueInvoiceNumber(fixtures.runId);

    const activitiesBefore = await prisma.activity.count({ where: { organizationId: fixtures.orgA.id, entityType: "INVOICE" } });

    const result = await createInvoiceAction(
      { error: null },
      buildFormData(invoiceNumber, fixtures.project.id, { mode: "bogus" }),
    );
    resetAuthMock();

    expect(result.error).toBeNull();
    expect(result.fieldErrors?.mode).toBeTruthy();

    const created = await prisma.invoice.findFirst({ where: { invoiceNumber } });
    expect(created).toBeNull();

    const activitiesAfter = await prisma.activity.count({ where: { organizationId: fixtures.orgA.id, entityType: "INVOICE" } });
    expect(activitiesAfter).toBe(activitiesBefore);
  });
});
