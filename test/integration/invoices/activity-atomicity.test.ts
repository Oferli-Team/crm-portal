import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { createInvoiceAction } from "@/app/(dashboard)/invoices/new/actions";
import { updateInvoiceAction } from "@/app/(dashboard)/invoices/[id]/edit/actions";
import { encodeInvoiceLineItemsFormValue } from "@/lib/invoices/line-items-form";
import { createActivity } from "@/lib/activity/create-activity";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";

/**
 * Proves Invoice create/edit mutations roll back atomically with their
 * Activity write. Uses Vitest's real module-mocking — wrapping the
 * imported createActivity in vi.fn() and forcing one rejected call — the
 * exact same technique already established and merged in
 * test/integration/comments/create.test.ts. No production code branches
 * on test state; nothing here is a production test hook.
 */
vi.mock("@/lib/activity/create-activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/activity/create-activity")>();
  return { ...actual, createActivity: vi.fn(actual.createActivity) };
});

const INVOICE_NUMBER_PREFIX = "INV-ATOMIC";

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

describe("Invoice mutation + Activity atomicity", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await cleanupTestData(fixtures);
  });

  it("create: a forced Activity-insert failure leaves no Invoice or InvoiceLineItem row behind", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    vi.mocked(createActivity).mockRejectedValueOnce(new Error("simulated failure"));

    const invoiceNumber = `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}-create`;
    const lineItems = encodeInvoiceLineItemsFormValue([{ description: "A", quantity: "1", unitPrice: "10.00" }]);

    await expect(
      createInvoiceAction({ error: null }, buildFormData(invoiceNumber, fixtures.project.id, { mode: "itemized", lineItems })),
    ).rejects.toThrow("simulated failure");
    resetAuthMock();

    const invoices = await prisma.invoice.findMany({ where: { invoiceNumber } });
    expect(invoices).toHaveLength(0);
    const lineItemRows = await prisma.invoiceLineItem.findMany({ where: { invoice: { invoiceNumber } } });
    expect(lineItemRows).toHaveLength(0);
  });

  it("edit: a forced Activity-insert failure rolls back the parent update AND the line-item replacement together", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const invoiceNumber = `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}-edit`;
    const originalLineItems = encodeInvoiceLineItemsFormValue([{ description: "Original", quantity: "1", unitPrice: "10.00" }]);

    let caught: unknown;
    try {
      await createInvoiceAction({ error: null }, buildFormData(invoiceNumber, fixtures.project.id, { mode: "itemized", lineItems: originalLineItems }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();

    const created = await prisma.invoice.findUniqueOrThrow({
      where: { organizationId_invoiceNumber: { organizationId: fixtures.orgA.id, invoiceNumber } },
      include: { lineItems: true },
    });
    expect(created.lineItems).toHaveLength(1);

    vi.mocked(createActivity).mockRejectedValueOnce(new Error("simulated failure"));
    const newLineItems = encodeInvoiceLineItemsFormValue([{ description: "Replacement", quantity: "2", unitPrice: "20.00" }]);

    await expect(
      updateInvoiceAction(
        created.id,
        created.updatedAt.toISOString(),
        { error: null },
        buildFormData(invoiceNumber, fixtures.project.id, { mode: "itemized", lineItems: newLineItems }),
      ),
    ).rejects.toThrow("simulated failure");
    resetAuthMock();

    const afterFailure = await prisma.invoice.findUniqueOrThrow({
      where: { id: created.id },
      include: { lineItems: true },
    });
    // The original line item survives untouched — the delete-then-recreate
    // never committed, rolling back together with the Activity failure.
    expect(afterFailure.lineItems).toHaveLength(1);
    expect(afterFailure.lineItems[0].description).toBe("Original");
    expect(afterFailure.amount.toFixed(2)).toBe("10.00");
  });
});
