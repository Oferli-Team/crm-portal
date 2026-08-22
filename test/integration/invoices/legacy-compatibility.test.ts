import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { buildInvoiceTotalsViewModel } from "@/lib/invoices/totals-view-model";
import { changeInvoiceStatusAction } from "@/app/(dashboard)/invoices/[id]/status-actions";
import { updateInvoiceInternalNotesAction } from "@/app/(dashboard)/invoices/[id]/internal-notes-actions";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";

/**
 * Proves Slice 2b tolerates a minimal, pre-Slice-1-shaped legacy row —
 * zero line items, and (since Invoice System Official Slice 5b's NOT
 * NULL contract, migration 20260915090000_add_invoice_totals_not_null_
 * contract) subtotal/discountAmount/taxAmount silently defaulted to 0
 * rather than genuinely null — through every code path this slice adds,
 * without crashing and without fabricating data. Before Slice 5b, a row
 * created without these three columns explicitly set had them as
 * literal SQL NULL; that state is now schema-impossible to construct at
 * all (the database itself rejects it), so this file's own fixtures and
 * assertions were updated to the new, only-reachable shape — the code
 * paths under test (view-model rendering, lifecycle transitions,
 * internalNotes) are otherwise unchanged, and buildInvoiceTotalsViewModel
 * itself was not modified. `amount` remains the canonical total every
 * Dashboard/Analytics/Search/Portal query already reads
 * (docs/invoicing-architecture.md §11); this slice writes nothing that
 * would change what those queries see for an untouched legacy row.
 */
const INVOICE_NUMBER_PREFIX = "INV-LEGACY";

describe("legacy invoice compatibility", () => {
  let fixtures: TestFixtures;
  let legacyDraft: { id: string; amount: unknown };
  let legacySent: { id: string; amount: unknown };

  beforeAll(async () => {
    fixtures = await seedTestData();
    // Deliberately omits subtotal/discountAmount/taxAmount — the closest
    // reachable equivalent to the pre-Slice-1 shape now that Slice 5b's
    // NOT NULL contract defaults an omitted value to 0 rather than
    // permitting a literal null.
    legacyDraft = await prisma.invoice.create({
      data: {
        invoiceNumber: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}-draft`,
        status: "DRAFT",
        amount: "321.00",
        projectId: fixtures.project.id,
        clientId: fixtures.clientA.id,
        organizationId: fixtures.orgA.id,
      },
    });
    legacySent = await prisma.invoice.create({
      data: {
        invoiceNumber: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}-sent`,
        status: "SENT",
        amount: "654.00",
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

  it("a legacy row fetched fresh from the DB has subtotal/discountAmount/taxAmount defaulted to 0.00, never null", async () => {
    const fetched = await prisma.invoice.findUniqueOrThrow({ where: { id: legacyDraft.id } });
    expect(fetched.subtotal.toFixed(2)).toBe("0.00");
    expect(fetched.discountAmount.toFixed(2)).toBe("0.00");
    expect(fetched.taxAmount.toFixed(2)).toBe("0.00");
    expect(fetched.amount.toFixed(2)).toBe("321.00");
  });

  it("buildInvoiceTotalsViewModel renders it safely — displays the real, defaulted-zero subtotal, no fabricated discount/tax rows, and amount remains the total regardless", async () => {
    const fetched = await prisma.invoice.findUniqueOrThrow({ where: { id: legacyDraft.id } });
    const totals = buildInvoiceTotalsViewModel({
      amount: fetched.amount,
      subtotal: fetched.subtotal,
      discountType: fetched.discountType,
      discountAmount: fetched.discountAmount,
      discountValue: fetched.discountValue,
      taxRatePercent: fetched.taxRatePercent,
      taxAmount: fetched.taxAmount,
      taxLabel: fetched.taxLabel,
      currency: fetched.currency,
    });
    // subtotal is now a real, persisted 0.00 (Slice 5b's DEFAULT 0) —
    // buildInvoiceTotalsViewModel's own `subtotal ?? amount` fallback
    // (still separately covered, unit-level, for a genuinely-null input,
    // by test/unit/invoice-totals-view-model.test.ts, unchanged) is no
    // longer exercised by a real database round-trip, since a real
    // fetched invoice.subtotal can never be null again. This is not a
    // fallback anymore — it is the literal persisted value.
    expect(totals.displayedSubtotal).toBe("$0.00");
    expect(totals.discountRow).toBeNull();
    expect(totals.taxRow).toBeNull();
    // total always reads invoice.amount directly, never subtotal — always
    // the real $321.00 regardless of this change.
    expect(totals.total).toBe("$321.00");
  });

  it("zero InvoiceLineItem rows is still the correct flat classification for a legacy row", async () => {
    const fetched = await prisma.invoice.findUniqueOrThrow({ where: { id: legacyDraft.id }, include: { lineItems: true } });
    expect(fetched.lineItems).toEqual([]);
  });

  it("lifecycle transitions work correctly on a legacy SENT row with defaulted-zero transitional totals", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await changeInvoiceStatusAction(legacySent.id, "PAID");
    resetAuthMock();

    expect(result).toEqual({ ok: true });
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: legacySent.id } });
    expect(after.status).toBe("PAID");
    expect(after.paidAt).not.toBeNull();
    // subtotal/discountAmount/taxAmount remain untouched (still their
    // defaulted 0.00) — the lifecycle action never writes them.
    expect(after.subtotal.toFixed(2)).toBe("0.00");
  });

  it("internalNotes can be set on a legacy row with defaulted-zero transitional totals", async () => {
    const legacyCancelled = await prisma.invoice.create({
      data: {
        invoiceNumber: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}-${randomUUID().slice(0, 8)}`,
        status: "CANCELLED",
        amount: "10.00",
        projectId: fixtures.project.id,
        clientId: fixtures.clientA.id,
        organizationId: fixtures.orgA.id,
      },
    });
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await updateInvoiceInternalNotesAction(legacyCancelled.id, "a note on a legacy row");
    resetAuthMock();

    expect(result).toEqual({ ok: true });
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: legacyCancelled.id } });
    expect(after.internalNotes).toBe("a note on a legacy row");
  });

  it("amount remains the canonical total unaffected by this slice for an untouched legacy row", async () => {
    const untouched = await prisma.invoice.findUniqueOrThrow({ where: { id: legacyDraft.id } });
    expect(untouched.amount.toFixed(2)).toBe("321.00");
  });
});
