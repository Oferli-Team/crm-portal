import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createInvoiceAction } from "@/app/(dashboard)/invoices/new/actions";
import { updateInvoiceAction } from "@/app/(dashboard)/invoices/[id]/edit/actions";
import { encodeInvoiceLineItemsFormValue } from "@/lib/invoices/line-items-form";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { RedirectSignal } from "../../support/navigation-mock";

const INVOICE_NUMBER_PREFIX = "INV-DEDIT";

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

async function createDraft(fixtures: TestFixtures, overrides: Record<string, string> = {}) {
  actAs(fixtures.owner, fixtures.orgA.id);
  const invoiceNumber = uniqueInvoiceNumber(fixtures.runId);
  await expectRedirect(createInvoiceAction({ error: null }, buildFormData(invoiceNumber, fixtures.project.id, overrides)));
  resetAuthMock();
  return prisma.invoice.findUniqueOrThrow({
    where: { organizationId_invoiceNumber: { organizationId: fixtures.orgA.id, invoiceNumber } },
    include: { lineItems: true },
  });
}

describe("updateInvoiceAction — DRAFT editing", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await cleanupTestData(fixtures);
  });

  it("flat edit: recomputes the total server-side", async () => {
    const created = await createDraft(fixtures, { amount: "50.00" });
    actAs(fixtures.owner, fixtures.orgA.id);

    await expectRedirect(
      updateInvoiceAction(
        created.id,
        created.updatedAt.toISOString(),
        { error: null },
        buildFormData(created.invoiceNumber, fixtures.project.id, { amount: "75.00" }),
      ),
    );
    resetAuthMock();

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: created.id } });
    expect(updated.amount.toFixed(2)).toBe("75.00");
  });

  it("switching flat -> itemized replaces the row's totals and creates ordered line items", async () => {
    const created = await createDraft(fixtures, { amount: "50.00" });
    actAs(fixtures.owner, fixtures.orgA.id);

    const lineItems = encodeInvoiceLineItemsFormValue([
      { description: "A", quantity: "2", unitPrice: "10.00" },
      { description: "B", quantity: "1", unitPrice: "5.00" },
    ]);
    await expectRedirect(
      updateInvoiceAction(
        created.id,
        created.updatedAt.toISOString(),
        { error: null },
        buildFormData(created.invoiceNumber, fixtures.project.id, { mode: "itemized", lineItems }),
      ),
    );
    resetAuthMock();

    const updated = await prisma.invoice.findUniqueOrThrow({
      where: { id: created.id },
      include: { lineItems: { orderBy: { position: "asc" } } },
    });
    expect(updated.lineItems).toHaveLength(2);
    expect(updated.amount.toFixed(2)).toBe("25.00");
  });

  it("switching itemized -> flat deletes the previously-persisted line items", async () => {
    const lineItems = encodeInvoiceLineItemsFormValue([{ description: "A", quantity: "1", unitPrice: "10.00" }]);
    const created = await createDraft(fixtures, { mode: "itemized", lineItems });
    expect(created.lineItems).toHaveLength(1);
    actAs(fixtures.owner, fixtures.orgA.id);

    await expectRedirect(
      updateInvoiceAction(
        created.id,
        created.updatedAt.toISOString(),
        { error: null },
        buildFormData(created.invoiceNumber, fixtures.project.id, { mode: "flat", amount: "42.00" }),
      ),
    );
    resetAuthMock();

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: created.id }, include: { lineItems: true } });
    expect(updated.lineItems).toEqual([]);
    expect(updated.amount.toFixed(2)).toBe("42.00");
  });

  it("server recomputation ignores a client-tampered total — the submitted amount alone drives calc, never a smuggled total field", async () => {
    const created = await createDraft(fixtures, { amount: "50.00" });
    actAs(fixtures.owner, fixtures.orgA.id);

    const fd = buildFormData(created.invoiceNumber, fixtures.project.id, { amount: "60.00" });
    // No "totalOverride"/"subtotal"/"status" field this form even reads —
    // parseInvoiceForm() only ever looks at the named fields it knows.
    fd.set("subtotal", "999999.99");
    fd.set("status", "PAID");

    await expectRedirect(updateInvoiceAction(created.id, created.updatedAt.toISOString(), { error: null }, fd));
    resetAuthMock();

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: created.id } });
    expect(updated.amount.toFixed(2)).toBe("60.00");
    expect(updated.status).toBe("DRAFT");
  });

  it("Project/Client injection across organizations is rejected", async () => {
    const created = await createDraft(fixtures);
    const orgBProject = await prisma.project.create({
      data: { name: "Org B Project", clientId: fixtures.clientB.id, organizationId: fixtures.orgB.id, ownerId: fixtures.orgBOwner.id, status: "IN_PROGRESS" },
    });
    actAs(fixtures.owner, fixtures.orgA.id);

    const result = await updateInvoiceAction(
      created.id,
      created.updatedAt.toISOString(),
      { error: null },
      buildFormData(created.invoiceNumber, orgBProject.id),
    );
    resetAuthMock();

    expect(result).toEqual({ error: null, fieldErrors: { projectId: "Select a valid project." } });
    await prisma.project.delete({ where: { id: orgBProject.id } });
  });

  it("a no-op resubmit creates no Activity and does not bump updatedAt", async () => {
    const created = await createDraft(fixtures, { amount: "88.00", issueDate: "2026-08-16" });
    actAs(fixtures.owner, fixtures.orgA.id);

    await expectRedirect(
      updateInvoiceAction(
        created.id,
        created.updatedAt.toISOString(),
        { error: null },
        buildFormData(created.invoiceNumber, fixtures.project.id, { amount: "88.00", issueDate: "2026-08-16" }),
      ),
    );
    resetAuthMock();

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.updatedAt.getTime()).toBe(created.updatedAt.getTime());
    const activityCount = await prisma.activity.count({ where: { entityId: created.id, action: "UPDATED" } });
    expect(activityCount).toBe(0);
  });

  it("UPDATED Activity metadata is names-only — never a value", async () => {
    const created = await createDraft(fixtures, { amount: "10.00", internalNotes: "old note" });
    actAs(fixtures.owner, fixtures.orgA.id);

    await expectRedirect(
      updateInvoiceAction(
        created.id,
        created.updatedAt.toISOString(),
        { error: null },
        buildFormData(created.invoiceNumber, fixtures.project.id, { amount: "20.00", internalNotes: "brand new secret note" }),
      ),
    );
    resetAuthMock();

    const activity = await prisma.activity.findFirstOrThrow({ where: { entityId: created.id, action: "UPDATED" } });
    const metadata = activity.metadata as Record<string, unknown>;
    expect(metadata.changedFields).toEqual(expect.arrayContaining(["amount", "internalNotes"]));
    expect(JSON.stringify(metadata)).not.toContain("secret note");
    expect(metadata).not.toHaveProperty("amount");
  });

  it("an invalid mode value changes no Invoice field, no line items, and creates no Activity", async () => {
    const lineItems = encodeInvoiceLineItemsFormValue([{ description: "Original", quantity: "1", unitPrice: "10.00" }]);
    const created = await createDraft(fixtures, { mode: "itemized", lineItems });
    actAs(fixtures.owner, fixtures.orgA.id);

    const result = await updateInvoiceAction(
      created.id,
      created.updatedAt.toISOString(),
      { error: null },
      buildFormData(created.invoiceNumber, fixtures.project.id, { mode: "bogus" }),
    );
    resetAuthMock();

    expect(result.error).toBeNull();
    expect(result.fieldErrors?.mode).toBeTruthy();

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: created.id }, include: { lineItems: true } });
    expect(after.updatedAt.getTime()).toBe(created.updatedAt.getTime());
    expect(after.lineItems).toHaveLength(1);
    expect(after.lineItems[0].description).toBe("Original");

    const activityCount = await prisma.activity.count({ where: { entityId: created.id, action: "UPDATED" } });
    expect(activityCount).toBe(0);
  });
});
