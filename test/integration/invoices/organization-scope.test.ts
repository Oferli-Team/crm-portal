import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createInvoiceAction } from "@/app/(dashboard)/invoices/new/actions";
import { updateInvoiceAction } from "@/app/(dashboard)/invoices/[id]/edit/actions";
import { getOrganizationMetrics } from "@/lib/analytics/queries/organization-metrics";
import { getInvoiceCompletionCounts } from "@/lib/analytics/queries/completion-metrics";
import { getInvoiceActivitySeries } from "@/lib/analytics/queries/time-series";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { RedirectSignal } from "../../support/navigation-mock";

/**
 * Proves the real fix for the previously-null Invoice.organizationId
 * defect: exercises the actual production createInvoiceAction/
 * updateInvoiceAction Server Actions (never a fixture that manufactures
 * organizationId directly), and proves the three Analytics read paths
 * (organization-metrics, completion-metrics, time-series) now correctly
 * count invoices created that way. Replaces the false-positive coverage
 * in test/integration/authorization/cross-org.test.ts's "invoice: scoped
 * by organizationId" case, which only ever proved that querying by
 * organizationId works *if* the column is already set — never that
 * production actually sets it.
 *
 * Invoice System Slice 2b: createInvoiceAction now always forces DRAFT
 * (status is never a submitted field), and updateInvoiceAction takes a
 * page-version `expectedUpdatedAt` argument and never changes status —
 * both updated here to match. The two paidAt-lifecycle cases that used to
 * live in this file (proven via directly-submitted status on create/edit)
 * moved to test/integration/invoices/lifecycle-transitions.test.ts, which
 * exercises them through the real changeInvoiceStatusAction instead.
 */

const INVOICE_NUMBER_PREFIX = "INV-SCOPE";

function uniqueInvoiceNumber(runId: string): string {
  return `${INVOICE_NUMBER_PREFIX}-${runId}-${randomUUID().slice(0, 8)}`;
}

function buildInvoiceFormData(fields: {
  invoiceNumber: string;
  projectId: string;
  amount?: string;
  dueDate?: string;
  notes?: string;
}): FormData {
  const formData = new FormData();
  formData.set("mode", "flat");
  formData.set("invoiceNumber", fields.invoiceNumber);
  formData.set("projectId", fields.projectId);
  formData.set("amount", fields.amount ?? "100.00");
  formData.set("currency", "USD");
  formData.set("issueDate", "2026-01-15");
  formData.set("dueDate", fields.dueDate ?? "");
  formData.set("notes", fields.notes ?? "");
  formData.set("internalNotes", "");
  formData.set("discountType", "NONE");
  formData.set("discountValue", "");
  formData.set("taxRatePercent", "");
  formData.set("taxLabel", "TAX");
  return formData;
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

describe("Invoice.organizationId — real production write/read paths", () => {
  let fixtures: TestFixtures;
  // A second Client/Project inside org A (the real production create path
  // always derives clientId from the selected project — see new/actions.ts
  // — so a same-org "change project" test needs a genuinely different
  // Client to prove clientId actually follows the new project).
  let clientA2: { id: string };
  let projectA2: { id: string };
  // A Project inside org B, to prove a cross-organization project can
  // never be injected via either the create or the edit action.
  let projectB: { id: string };

  beforeAll(async () => {
    fixtures = await seedTestData();

    clientA2 = await prisma.client.create({
      data: {
        name: `Org A Second Client ${fixtures.runId}`,
        userId: fixtures.owner.id,
        organizationId: fixtures.orgA.id,
      },
    });
    projectA2 = await prisma.project.create({
      data: {
        name: `Org A Second Project ${fixtures.runId}`,
        clientId: clientA2.id,
        organizationId: fixtures.orgA.id,
        ownerId: fixtures.owner.id,
        status: "IN_PROGRESS",
      },
    });
    projectB = await prisma.project.create({
      data: {
        name: `Org B Project ${fixtures.runId}`,
        clientId: fixtures.clientB.id,
        organizationId: fixtures.orgB.id,
        ownerId: fixtures.orgBOwner.id,
        status: "IN_PROGRESS",
      },
    });
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await prisma.project.deleteMany({ where: { id: { in: [projectA2.id, projectB.id] } } });
    await prisma.client.deleteMany({ where: { id: clientA2.id } });
    await cleanupTestData(fixtures);
  });

  describe("A. createInvoiceAction — the real create path", () => {
    it("persists organizationId from the authenticated organization, and clientId from the selected project", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const invoiceNumber = uniqueInvoiceNumber(fixtures.runId);

      await expectRedirect(
        createInvoiceAction({ error: null }, buildInvoiceFormData({ invoiceNumber, projectId: fixtures.project.id })),
      );

      const created = await prisma.invoice.findUnique({ where: { organizationId_invoiceNumber: { organizationId: fixtures.orgA.id, invoiceNumber } } });
      expect(created).not.toBeNull();
      expect(created?.organizationId).toBe(fixtures.orgA.id);
      expect(created?.clientId).toBe(fixtures.clientA.id);
      expect(created?.projectId).toBe(fixtures.project.id);
      expect(created?.status).toBe("DRAFT");

      resetAuthMock();
    });

    it("rejects a cross-organization Project — no invoice is created", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const invoiceNumber = uniqueInvoiceNumber(fixtures.runId);

      const result = await createInvoiceAction(
        { error: null },
        buildInvoiceFormData({ invoiceNumber, projectId: projectB.id }),
      );
      expect(result).toEqual({ error: null, fieldErrors: { projectId: "Select a valid project." } });

      const created = await prisma.invoice.findFirst({ where: { invoiceNumber } });
      expect(created).toBeNull();

      resetAuthMock();
    });
  });

  describe("B. updateInvoiceAction — the real edit/project-change path", () => {
    it("changing to another Project in the same organization updates projectId/clientId while preserving organizationId", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const invoiceNumber = uniqueInvoiceNumber(fixtures.runId);
      await expectRedirect(
        createInvoiceAction({ error: null }, buildInvoiceFormData({ invoiceNumber, projectId: fixtures.project.id })),
      );
      const created = await prisma.invoice.findUniqueOrThrow({
        where: { organizationId_invoiceNumber: { organizationId: fixtures.orgA.id, invoiceNumber } },
      });

      await expectRedirect(
        updateInvoiceAction(
          created.id,
          created.updatedAt.toISOString(),
          { error: null },
          buildInvoiceFormData({ invoiceNumber, projectId: projectA2.id }),
        ),
      );

      const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: created.id } });
      expect(updated.projectId).toBe(projectA2.id);
      expect(updated.clientId).toBe(clientA2.id);
      expect(updated.organizationId).toBe(fixtures.orgA.id);

      resetAuthMock();
    });

    it("rejects a cross-organization Project — the invoice's project/client/organizationId are left unchanged", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const invoiceNumber = uniqueInvoiceNumber(fixtures.runId);
      await expectRedirect(
        createInvoiceAction({ error: null }, buildInvoiceFormData({ invoiceNumber, projectId: fixtures.project.id })),
      );
      const created = await prisma.invoice.findUniqueOrThrow({
        where: { organizationId_invoiceNumber: { organizationId: fixtures.orgA.id, invoiceNumber } },
      });

      const result = await updateInvoiceAction(
        created.id,
        created.updatedAt.toISOString(),
        { error: null },
        buildInvoiceFormData({ invoiceNumber, projectId: projectB.id }),
      );
      expect(result).toEqual({ error: null, fieldErrors: { projectId: "Select a valid project." } });

      const unchanged = await prisma.invoice.findUniqueOrThrow({ where: { id: created.id } });
      expect(unchanged.projectId).toBe(fixtures.project.id);
      expect(unchanged.clientId).toBe(fixtures.clientA.id);
      expect(unchanged.organizationId).toBe(fixtures.orgA.id);

      resetAuthMock();
    });
  });

  describe("C. Analytics — organization-metrics, completion-metrics, time-series", () => {
    it("organization-metrics.totalInvoices counts an invoice created through the real path, and excludes another organization's", async () => {
      const before = await getOrganizationMetrics(prisma, fixtures.orgA.id);

      actAs(fixtures.owner, fixtures.orgA.id);
      const invoiceNumber = uniqueInvoiceNumber(fixtures.runId);
      await expectRedirect(
        createInvoiceAction({ error: null }, buildInvoiceFormData({ invoiceNumber, projectId: fixtures.project.id })),
      );
      resetAuthMock();

      const after = await getOrganizationMetrics(prisma, fixtures.orgA.id);
      expect(after.totalInvoices).toBe(before.totalInvoices + 1);

      // Org B's own metrics must never see org A's invoice.
      const orgBMetrics = await getOrganizationMetrics(prisma, fixtures.orgB.id);
      const orgBInvoiceCount = await prisma.invoice.count({ where: { organizationId: fixtures.orgB.id } });
      expect(orgBMetrics.totalInvoices).toBe(orgBInvoiceCount);
    });

    it("completion-metrics counts a real PAID and a real CANCELLED invoice, scoped to the correct organization", async () => {
      const before = await getInvoiceCompletionCounts(prisma, fixtures.orgA.id);

      // Slice 2b ships no DRAFT -> SENT/PAID/CANCELLED transition (Issue
      // doesn't exist until Slice 3) — a PAID/CANCELLED row cannot be
      // produced from a fresh DRAFT through any 2b production action.
      // Seeded directly via Prisma, matching the same "setup only, not an
      // authorization claim" exception already established for legacy
      // non-DRAFT fixtures elsewhere (legacy-compatibility.test.ts) — this
      // test's own purpose is proving the Analytics read path, not the
      // status-write path (that's lifecycle-transitions.test.ts's job).
      const paidNumber = uniqueInvoiceNumber(fixtures.runId);
      const cancelledNumber = uniqueInvoiceNumber(fixtures.runId);
      await prisma.invoice.createMany({
        data: [
          {
            invoiceNumber: paidNumber,
            status: "PAID",
            amount: "100.00",
            subtotal: "100.00",
            discountAmount: "0.00",
            taxAmount: "0.00",
            paidAt: new Date(),
            projectId: fixtures.project.id,
            clientId: fixtures.clientA.id,
            organizationId: fixtures.orgA.id,
          },
          {
            invoiceNumber: cancelledNumber,
            status: "CANCELLED",
            amount: "100.00",
            subtotal: "100.00",
            discountAmount: "0.00",
            taxAmount: "0.00",
            projectId: fixtures.project.id,
            clientId: fixtures.clientA.id,
            organizationId: fixtures.orgA.id,
          },
        ],
      });

      const after = await getInvoiceCompletionCounts(prisma, fixtures.orgA.id);
      expect(after.paidInvoices).toBe(before.paidInvoices + 1);
      expect(after.cancelledInvoices).toBe(before.cancelledInvoices + 1);
    });

    it("time-series (getInvoiceActivitySeries) includes an invoice created through the real path within its bucket window", async () => {
      const bounds = { start: new Date(Date.now() - 24 * 60 * 60 * 1000), end: new Date(Date.now() + 24 * 60 * 60 * 1000) };

      const before = await getInvoiceActivitySeries(prisma, fixtures.orgA.id, bounds, "day");
      const beforeTotal = before.points.reduce((sum, p) => sum + p.created, 0);

      actAs(fixtures.owner, fixtures.orgA.id);
      const invoiceNumber = uniqueInvoiceNumber(fixtures.runId);
      await expectRedirect(
        createInvoiceAction({ error: null }, buildInvoiceFormData({ invoiceNumber, projectId: fixtures.project.id })),
      );
      resetAuthMock();

      const after = await getInvoiceActivitySeries(prisma, fixtures.orgA.id, bounds, "day");
      const afterTotal = after.points.reduce((sum, p) => sum + p.created, 0);
      expect(afterTotal).toBe(beforeTotal + 1);
    });
  });

  // Schema-level regression coverage for the repair itself, in the same
  // style as test/integration/security/grants.test.ts — queries
  // information_schema against the real, fully-applied migration history
  // (see test/support/local-postgres.ts), not a snapshot of the migration
  // file's text.
  describe("E. migration invariant (20260911090000_repair_invoice_organization_scope)", () => {
    it("the migration is applied and finished", async () => {
      const rows = await prisma.$queryRawUnsafe<{ migration_name: string; finished_at: Date | null }[]>(
        `SELECT migration_name, finished_at FROM _prisma_migrations WHERE migration_name = '20260911090000_repair_invoice_organization_scope'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].finished_at).not.toBeNull();
    });

    it("Invoice.organizationId is NOT NULL", async () => {
      const rows = await prisma.$queryRawUnsafe<{ is_nullable: string }[]>(
        `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'Invoice' AND column_name = 'organizationId'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].is_nullable).toBe("NO");
    });

    it("Invoice_organizationId_fkey is ON DELETE RESTRICT", async () => {
      const rows = await prisma.$queryRawUnsafe<{ delete_rule: string }[]>(
        `SELECT delete_rule FROM information_schema.referential_constraints WHERE constraint_name = 'Invoice_organizationId_fkey'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].delete_rule).toBe("RESTRICT");
    });
  });
});
