import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createInvoiceAction } from "@/app/(dashboard)/invoices/new/actions";
import { getDuplicateSourceInvoice } from "@/lib/invoices/duplicate-source";
import { buildDuplicateInvoiceDefaults, type DuplicateInvoiceDefaults, type DuplicateSourceData } from "@/lib/invoices/duplicate";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { RedirectSignal } from "../../support/navigation-mock";
import type { InvoiceStatusValue } from "@/lib/validation/invoice";

const INVOICE_NUMBER_PREFIX = "INV-DUP";

function uniqueInvoiceNumber(runId: string): string {
  return `${INVOICE_NUMBER_PREFIX}-${runId}-${randomUUID().slice(0, 8)}`;
}

/**
 * Polls `check()` until `predicate()` accepts its result, matching this
 * suite's own established pattern for waiting on eventual consistency
 * (test/support/local-postgres.ts's `waitForSocketReady()`) rather than a
 * fixed sleep — returns as soon as the harness has actually settled.
 *
 * A `check()` call that throws mid-poll is treated as "not yet settled,"
 * not as failure — retried the same as a predicate miss, since the exact
 * local PGlite/`max: 1`-pool artifact this helper exists for (see the
 * collision test's own comment) can surface as a genuinely malformed
 * response immediately after a rolled-back transaction, not only as a
 * stale-but-well-formed one. Timeout is never itself treated as success:
 * the final attempt after the loop is unguarded, so it either returns the
 * real, current, settled state for the caller's own explicit assertions
 * to check, or — if the harness is still not settled — rethrows that
 * real error instead of silently returning a stale/guessed value.
 */
async function pollUntilStable<T>(
  check: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 2000,
  intervalMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (predicate(value)) return value;
    } catch {
      // Retried below — see this function's own doc comment.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return check();
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

type SeedInvoiceOverrides = {
  invoiceNumber?: string;
  status?: InvoiceStatusValue;
  amount?: string;
  currency?: string;
  notes?: string | null;
  discountType?: "NONE" | "PERCENTAGE" | "FIXED";
  discountValue?: string | null;
  taxRatePercent?: string | null;
  taxLabel?: "TAX" | "VAT" | "GST";
  lineItems?: { description: string; quantity: string; unitPrice: string }[];
  organizationId?: string;
  clientId?: string;
  projectId?: string;
};

async function seedInvoice(fixtures: TestFixtures, overrides: SeedInvoiceOverrides = {}) {
  const invoiceNumber = overrides.invoiceNumber ?? uniqueInvoiceNumber(fixtures.runId);
  const lineItems = overrides.lineItems ?? [];
  return prisma.invoice.create({
    data: {
      invoiceNumber,
      status: overrides.status ?? "CANCELLED",
      amount: overrides.amount ?? "100.00",
      subtotal: overrides.amount ?? "100.00",
      discountAmount: "0.00",
      taxAmount: "0.00",
      currency: overrides.currency ?? "USD",
      notes: overrides.notes ?? null,
      discountType: overrides.discountType ?? "NONE",
      discountValue: overrides.discountValue ?? null,
      taxRatePercent: overrides.taxRatePercent ?? null,
      taxLabel: overrides.taxLabel ?? "TAX",
      projectId: overrides.projectId ?? fixtures.project.id,
      clientId: overrides.clientId ?? fixtures.clientA.id,
      organizationId: overrides.organizationId ?? fixtures.orgA.id,
      lineItems:
        lineItems.length > 0
          ? {
              create: lineItems.map((li, index) => ({
                description: li.description,
                quantity: li.quantity,
                unitPrice: li.unitPrice,
                lineTotal: (Number(li.quantity) * Number(li.unitPrice)).toFixed(2),
                position: index,
              })),
            }
          : undefined,
    },
    include: { lineItems: { orderBy: { position: "asc" } } },
  });
}

function toSourceData(source: {
  invoiceNumber: string;
  projectId: string;
  amount: unknown;
  currency: string;
  notes: string | null;
  discountType: "NONE" | "PERCENTAGE" | "FIXED";
  discountValue: unknown;
  taxRatePercent: unknown;
  taxLabel: "TAX" | "VAT" | "GST";
  lineItems: { description: string; quantity: unknown; unitPrice: unknown }[];
}): DuplicateSourceData {
  return {
    invoiceNumber: source.invoiceNumber,
    projectId: source.projectId,
    amount: String(source.amount),
    currency: source.currency.trim().toUpperCase(),
    notes: source.notes,
    discountType: source.discountType,
    discountValue: source.discountValue === null || source.discountValue === undefined ? null : String(source.discountValue),
    taxRatePercent: source.taxRatePercent === null || source.taxRatePercent === undefined ? null : String(source.taxRatePercent),
    taxLabel: source.taxLabel,
    lineItems: source.lineItems.map((li) => ({
      description: li.description,
      quantity: String(li.quantity),
      unitPrice: String(li.unitPrice),
    })),
  };
}

function buildFormDataFromDuplicateDefaults(
  defaults: DuplicateInvoiceDefaults,
  extraTopLevel: Record<string, string> = {},
  extraLineItemKeys: Record<string, string> = {},
): FormData {
  const fd = new FormData();
  fd.set("invoiceNumber", defaults.invoiceNumber);
  fd.set("projectId", defaults.projectId);
  fd.set("mode", defaults.mode);
  fd.set("amount", defaults.amount);
  fd.set(
    "lineItems",
    defaults.mode === "itemized" ? JSON.stringify(defaults.lineItems.map((li) => ({ ...li, ...extraLineItemKeys }))) : "",
  );
  fd.set("currency", defaults.currency);
  fd.set("issueDate", defaults.issueDate);
  fd.set("dueDate", defaults.dueDate);
  fd.set("notes", defaults.notes);
  fd.set("internalNotes", defaults.internalNotes);
  fd.set("discountType", defaults.discountType);
  fd.set("discountValue", defaults.discountValue);
  fd.set("taxRatePercent", defaults.taxRatePercent);
  fd.set("taxLabel", defaults.taxLabel);
  for (const [key, value] of Object.entries(extraTopLevel)) fd.set(key, value);
  return fd;
}

const TODAY = new Date("2026-08-17T12:00:00.000Z");

describe("getDuplicateSourceInvoice — loader eligibility/isolation", () => {
  let fixtures: TestFixtures;
  let projectB: { id: string };

  beforeAll(async () => {
    fixtures = await seedTestData();
    projectB = await prisma.project.create({
      data: {
        name: `Org B Duplicate Project ${fixtures.runId}`,
        clientId: fixtures.clientB.id,
        organizationId: fixtures.orgB.id,
        ownerId: fixtures.orgBOwner.id,
        status: "IN_PROGRESS",
      },
    });
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await prisma.project.deleteMany({ where: { id: projectB.id } });
    await cleanupTestData(fixtures);
  });

  it("returns an authorized CANCELLED flat source", async () => {
    const invoice = await seedInvoice(fixtures, { status: "CANCELLED", amount: "250.00" });
    const result = await getDuplicateSourceInvoice(invoice.id, fixtures.orgA.id);
    expect(result).not.toBeNull();
    expect(result?.invoiceNumber).toBe(invoice.invoiceNumber);
    expect(result?.lineItems).toEqual([]);
  });

  it("returns an authorized CANCELLED itemized source with ordered line items", async () => {
    const invoice = await seedInvoice(fixtures, {
      status: "CANCELLED",
      lineItems: [
        { description: "Design", quantity: "2", unitPrice: "50.00" },
        { description: "Hosting", quantity: "1", unitPrice: "29.99" },
      ],
    });
    const result = await getDuplicateSourceInvoice(invoice.id, fixtures.orgA.id);
    expect(result?.lineItems).toEqual([
      { description: "Design", quantity: expect.anything(), unitPrice: expect.anything() },
      { description: "Hosting", quantity: expect.anything(), unitPrice: expect.anything() },
    ]);
    expect(result?.lineItems[0].description).toBe("Design");
    expect(result?.lineItems[1].description).toBe("Hosting");
  });

  it.each<InvoiceStatusValue>(["DRAFT", "SENT", "PAID", "OVERDUE"])("returns null for a %s source", async (status) => {
    const invoice = await seedInvoice(fixtures, { status });
    const result = await getDuplicateSourceInvoice(invoice.id, fixtures.orgA.id);
    expect(result).toBeNull();
  });

  it("returns null for a cross-organization CANCELLED source", async () => {
    const invoice = await seedInvoice(fixtures, {
      status: "CANCELLED",
      organizationId: fixtures.orgB.id,
      clientId: fixtures.clientB.id,
      projectId: projectB.id,
    });
    const result = await getDuplicateSourceInvoice(invoice.id, fixtures.orgA.id);
    expect(result).toBeNull();
  });

  it("returns null for a nonexistent id", async () => {
    const result = await getDuplicateSourceInvoice(randomUUID(), fixtures.orgA.id);
    expect(result).toBeNull();
  });

  it("returns a raw, un-normalized currency unchanged — no canonicalization at the query layer", async () => {
    const invoice = await seedInvoice(fixtures, { status: "CANCELLED", currency: " usd " });
    const result = await getDuplicateSourceInvoice(invoice.id, fixtures.orgA.id);
    expect(result?.currency).toBe(" usd ");
  });

  it.each(["JPY", "XYZ"])("returns an unsupported currency (%s) unchanged — no fallback or rejection at the query layer", async (currency) => {
    const invoice = await seedInvoice(fixtures, { status: "CANCELLED", currency });
    const result = await getDuplicateSourceInvoice(invoice.id, fixtures.orgA.id);
    expect(result?.currency).toBe(currency);
  });

  it("returns exactly the selected top-level keys — no accidental scalar-field expansion", async () => {
    const invoice = await seedInvoice(fixtures, { status: "CANCELLED" });
    const result = await getDuplicateSourceInvoice(invoice.id, fixtures.orgA.id);
    expect(Object.keys(result!).sort()).toEqual(
      [
        "id",
        "invoiceNumber",
        "projectId",
        "amount",
        "currency",
        "notes",
        "discountType",
        "discountValue",
        "taxRatePercent",
        "taxLabel",
        "lineItems",
      ].sort(),
    );
  });

  it("returns exactly description/quantity/unitPrice for each line item — no id/position/lineTotal/timestamps", async () => {
    const invoice = await seedInvoice(fixtures, {
      status: "CANCELLED",
      lineItems: [{ description: "Design", quantity: "1", unitPrice: "10.00" }],
    });
    const result = await getDuplicateSourceInvoice(invoice.id, fixtures.orgA.id);
    expect(Object.keys(result!.lineItems[0]).sort()).toEqual(["description", "quantity", "unitPrice"].sort());
  });

  it("calling the loader performs zero writes — scoped Invoice/InvoiceLineItem/Activity state is unchanged", async () => {
    const invoice = await seedInvoice(fixtures, {
      status: "CANCELLED",
      lineItems: [{ description: "Design", quantity: "1", unitPrice: "10.00" }],
    });

    const invoiceCountBefore = await prisma.invoice.count({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    const lineItemCountBefore = await prisma.invoiceLineItem.count({ where: { invoiceId: invoice.id } });
    const activityCountBefore = await prisma.activity.count({
      where: { organizationId: fixtures.orgA.id, entityType: "INVOICE", entityId: invoice.id },
    });

    await getDuplicateSourceInvoice(invoice.id, fixtures.orgA.id);
    await getDuplicateSourceInvoice(invoice.id, fixtures.orgA.id);

    const invoiceCountAfter = await prisma.invoice.count({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    const lineItemCountAfter = await prisma.invoiceLineItem.count({ where: { invoiceId: invoice.id } });
    const activityCountAfter = await prisma.activity.count({
      where: { organizationId: fixtures.orgA.id, entityType: "INVOICE", entityId: invoice.id },
    });

    expect(invoiceCountAfter).toBe(invoiceCountBefore);
    expect(lineItemCountAfter).toBe(lineItemCountBefore);
    expect(activityCountAfter).toBe(activityCountBefore);
  });
});

describe("createInvoiceAction via duplicate-derived FormData — real action, tampering proof, source immutability", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await cleanupTestData(fixtures);
  });

  it("flat: creates a fresh DRAFT with the copied amount, distinct id, source untouched", async () => {
    const source = await seedInvoice(fixtures, { amount: "250.00" });
    const defaults = buildDuplicateInvoiceDefaults(toSourceData(source), TODAY);

    actAs(fixtures.owner, fixtures.orgA.id);
    await expectRedirect(createInvoiceAction({ error: null }, buildFormDataFromDuplicateDefaults(defaults)));
    resetAuthMock();

    const created = await prisma.invoice.findUniqueOrThrow({
      where: { organizationId_invoiceNumber: { organizationId: fixtures.orgA.id, invoiceNumber: defaults.invoiceNumber } },
      include: { lineItems: true },
    });
    expect(created.id).not.toBe(source.id);
    expect(created.status).toBe("DRAFT");
    expect(created.paidAt).toBeNull();
    expect(created.amount.toFixed(2)).toBe("250.00");
    expect(created.lineItems).toEqual([]);
    expect(created.finalizedAt).toBeNull();
    expect(created.pdfStoragePath).toBeNull();

    const sourceAfter = await prisma.invoice.findUniqueOrThrow({ where: { id: source.id } });
    expect(sourceAfter.status).toBe("CANCELLED");
    expect(sourceAfter.updatedAt.getTime()).toBe(source.updatedAt.getTime());
  });

  it("itemized: recomputes totals/positions server-side and ignores every forged authoritative field", async () => {
    const source = await seedInvoice(fixtures, {
      lineItems: [
        { description: "Design work", quantity: "10.5", unitPrice: "85.00" },
        { description: "Hosting", quantity: "1", unitPrice: "29.99" },
      ],
      discountType: "PERCENTAGE",
      discountValue: "10",
      taxRatePercent: "8.25",
    });
    const sourceLineItemsBefore = [...source.lineItems];
    const defaults = buildDuplicateInvoiceDefaults(toSourceData(source), TODAY);
    expect(defaults.amount).toBe(""); // itemized — never a dormant copy of the source total

    const formData = buildFormDataFromDuplicateDefaults(
      defaults,
      {
        subtotal: "1.00",
        discountAmount: "1.00",
        taxAmount: "1.00",
        sourceInvoiceId: source.id,
        status: "SENT",
        paidAt: new Date().toISOString(),
        finalizedAt: new Date().toISOString(),
        pdfStoragePath: "organizations/forged/invoice-pdf/forged.pdf",
      },
      { lineTotal: "999999.99", position: "999" },
    );

    actAs(fixtures.owner, fixtures.orgA.id);
    await expectRedirect(createInvoiceAction({ error: null }, formData));
    resetAuthMock();

    const created = await prisma.invoice.findUniqueOrThrow({
      where: { organizationId_invoiceNumber: { organizationId: fixtures.orgA.id, invoiceNumber: defaults.invoiceNumber } },
      include: { lineItems: { orderBy: { position: "asc" } } },
    });

    // Matches calculateInvoiceTotals()'s own worked example for these
    // exact inputs — the forged subtotal/discountAmount/taxAmount above
    // are never read.
    expect(created.subtotal?.toFixed(2)).toBe("922.49");
    expect(created.discountAmount?.toFixed(2)).toBe("92.25");
    expect(created.taxAmount?.toFixed(2)).toBe("68.49");
    expect(created.amount.toFixed(2)).toBe("898.73");

    expect(created.status).toBe("DRAFT");
    expect(created.paidAt).toBeNull();
    expect(created.finalizedAt).toBeNull();
    expect(created.pdfStoragePath).toBeNull();
    expect(created.organizationId).toBe(fixtures.orgA.id);
    expect(created.clientId).toBe(fixtures.clientA.id);
    expect(created.id).not.toBe(source.id);

    expect(created.lineItems).toHaveLength(2);
    expect(created.lineItems[0]).toMatchObject({ description: "Design work", position: 0 });
    expect(created.lineItems[1]).toMatchObject({ description: "Hosting", position: 1 });
    expect(created.lineItems[0].id).not.toBe(sourceLineItemsBefore[0].id);
    expect(created.lineItems[0].lineTotal.toFixed(2)).toBe("892.50"); // 10.5 * 85.00, server-computed
    expect(created.lineItems[1].lineTotal.toFixed(2)).toBe("29.99");

    // No attachments/email attempts copied — nothing writes either relation.
    const attachmentCount = await prisma.attachment.count({ where: { entityType: "INVOICE", entityId: created.id } });
    expect(attachmentCount).toBe(0);
    const emailAttemptCount = await prisma.invoiceEmailAttempt.count({ where: { invoiceId: created.id } });
    expect(emailAttemptCount).toBe(0);

    const activity = await prisma.activity.findFirstOrThrow({ where: { entityId: created.id, action: "CREATED" } });
    const metadata = activity.metadata as Record<string, unknown>;
    expect(metadata.status).toBe("DRAFT");
    const metadataString = JSON.stringify(metadata);
    expect(metadataString).not.toContain(source.id);
    expect(metadataString).not.toContain("Design work");
    expect(metadataString).not.toContain("Hosting");
    const activityCountForNew = await prisma.activity.count({
      where: { organizationId: fixtures.orgA.id, entityType: "INVOICE", entityId: created.id },
    });
    expect(activityCountForNew).toBe(1);

    // Source row and its own line items remain byte-for-byte unchanged.
    const sourceAfter = await prisma.invoice.findUniqueOrThrow({
      where: { id: source.id },
      include: { lineItems: { orderBy: { position: "asc" } } },
    });
    expect(sourceAfter.status).toBe("CANCELLED");
    expect(sourceAfter.updatedAt.getTime()).toBe(source.updatedAt.getTime());
    expect(sourceAfter.lineItems.map((li) => ({ description: li.description, quantity: li.quantity.toString(), unitPrice: li.unitPrice.toString() }))).toEqual(
      sourceLineItemsBefore.map((li) => ({ description: li.description, quantity: li.quantity.toString(), unitPrice: li.unitPrice.toString() })),
    );
    const activityCountForSource = await prisma.activity.count({
      where: { organizationId: fixtures.orgA.id, entityType: "INVOICE", entityId: source.id },
    });
    expect(activityCountForSource).toBe(0);
  });

  it("collision: resubmitting the same suggested number in the same client scope returns the existing field error, no partial write", async () => {
    const source = await seedInvoice(fixtures, { amount: "50.00" });
    const defaults = buildDuplicateInvoiceDefaults(toSourceData(source), TODAY);

    actAs(fixtures.owner, fixtures.orgA.id);
    await expectRedirect(createInvoiceAction({ error: null }, buildFormDataFromDuplicateDefaults(defaults)));

    // Exact-scope state right after the first, successful create — this
    // fixture is flat, so zero InvoiceLineItem rows is the expected
    // baseline both now and after the rejected second attempt below.
    const firstCreated = await prisma.invoice.findUniqueOrThrow({
      where: { organizationId_invoiceNumber: { organizationId: fixtures.orgA.id, invoiceNumber: defaults.invoiceNumber } },
    });
    const lineItemsAfterFirst = await prisma.invoiceLineItem.findMany({ where: { invoiceId: firstCreated.id } });
    const activityAfterFirst = await prisma.activity.findMany({
      where: { organizationId: fixtures.orgA.id, entityType: "INVOICE", entityId: firstCreated.id },
    });
    expect(lineItemsAfterFirst).toHaveLength(0);
    expect(activityAfterFirst).toHaveLength(1);
    expect(activityAfterFirst[0].action).toBe("CREATED");

    const result = await createInvoiceAction({ error: null }, buildFormDataFromDuplicateDefaults(defaults));
    resetAuthMock();

    expect(result.fieldErrors?.invoiceNumber).toBeTruthy();

    // The rejected second attempt rolls back inside prisma.$transaction();
    // the shared local PGlite/pg-adapter test harness (`max: 1` pool, see
    // src/lib/prisma.ts) needs a brief moment to settle that rollback
    // before a fresh read is guaranteed consistent — reproduced even
    // against the plain, unmodified createInvoiceAction with no
    // duplicate-specific code involved. pollUntilStable (declared above)
    // polls for the full expected end state rather than sleeping a fixed
    // amount, so this resolves as soon as the harness has actually
    // settled, not after an arbitrary delay. A poll timeout is never
    // itself treated as success — whatever pollUntilStable last observed
    // (settled or not) is asserted explicitly below, so a genuine
    // regression (e.g. a real second Invoice/Activity/line-item row)
    // still fails this test rather than silently timing out green.
    const finalState = await pollUntilStable(
      async () => ({
        invoices: await prisma.invoice.findMany({
          where: { clientId: fixtures.clientA.id, invoiceNumber: defaults.invoiceNumber },
        }),
        lineItems: await prisma.invoiceLineItem.findMany({ where: { invoiceId: firstCreated.id } }),
        activity: await prisma.activity.findMany({
          where: { organizationId: fixtures.orgA.id, entityType: "INVOICE", entityId: firstCreated.id },
        }),
      }),
      (state) => state.invoices.length === 1 && state.activity.length === 1,
    );

    // Exactly one matching Invoice — the original successfully-created
    // duplicate, never a second row.
    expect(finalState.invoices).toHaveLength(1);
    expect(finalState.invoices[0].id).toBe(firstCreated.id);
    // InvoiceLineItem state unchanged (still zero — this fixture is flat).
    expect(finalState.lineItems).toHaveLength(0);
    // Exactly one CREATED Activity for the original invoice — the
    // rejected attempt produced no additional Activity of any kind.
    expect(finalState.activity).toHaveLength(1);
    expect(finalState.activity[0].entityId).toBe(firstCreated.id);
    expect(finalState.activity[0].action).toBe("CREATED");
  });
});
