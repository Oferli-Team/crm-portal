import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getPortalInvoice, getPortalInvoices, getPortalOverview } from "@/lib/client-portal/queries";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";

/**
 * Invoice System Official Slice 5 — Portal DRAFT-visibility correction
 * (docs/invoicing-architecture.md §10). Calls the real, unmodified query
 * functions directly against real seeded Prisma data — no mocking
 * needed, since every function under test takes clientId/organizationId
 * explicitly as a plain parameter (same precedent as
 * test/integration/portal/authorization.test.ts). Proves the corrected
 * VISIBLE_PORTAL_STATUSES/OPEN_INVOICE_STATUSES predicate on every
 * affected surface: direct detail lookup, both list filters, and both
 * overview aggregates.
 */
describe("Portal Invoice visibility — DRAFT is never visible; SENT/OVERDUE/PAID/CANCELLED remain visible", () => {
  let fixtures: TestFixtures;
  let draftInvoice: { id: string };
  let sentInvoice: { id: string };
  let overdueInvoice: { id: string };
  let paidInvoice: { id: string };
  let cancelledInvoice: { id: string };
  let sameOrgDifferentClient: { id: string; clientId: string };
  let allInvoiceIds: string[];

  beforeAll(async () => {
    fixtures = await seedTestData();

    const commonData = { projectId: fixtures.project.id, clientId: fixtures.clientA.id, organizationId: fixtures.orgA.id, issueDate: new Date() };

    draftInvoice = await prisma.invoice.create({
      data: { ...commonData, invoiceNumber: "SLICE5-DRAFT-1", amount: "100.00", status: "DRAFT" },
    });
    sentInvoice = await prisma.invoice.create({
      data: { ...commonData, invoiceNumber: "SLICE5-SENT-1", amount: "200.00", status: "SENT" },
    });
    overdueInvoice = await prisma.invoice.create({
      data: { ...commonData, invoiceNumber: "SLICE5-OVERDUE-1", amount: "300.00", status: "OVERDUE" },
    });
    paidInvoice = await prisma.invoice.create({
      data: { ...commonData, invoiceNumber: "SLICE5-PAID-1", amount: "400.00", status: "PAID", paidAt: new Date() },
    });
    cancelledInvoice = await prisma.invoice.create({
      data: { ...commonData, invoiceNumber: "SLICE5-CANCELLED-1", amount: "500.00", status: "CANCELLED" },
    });

    // A second, genuinely different Client inside the SAME organization —
    // fixtures.clientB belongs to a different organization entirely, so it
    // cannot prove the same-organization/different-Client isolation case.
    const otherClient = await prisma.client.create({
      data: { name: "Slice 5 Other Client", organizationId: fixtures.orgA.id, userId: fixtures.owner.id },
    });
    sameOrgDifferentClient = await prisma.invoice
      .create({
        data: {
          invoiceNumber: "SLICE5-OTHER-CLIENT-1",
          amount: "600.00",
          status: "SENT",
          issueDate: new Date(),
          projectId: fixtures.project.id,
          clientId: otherClient.id,
          organizationId: fixtures.orgA.id,
        },
      })
      .then((invoice) => ({ id: invoice.id, clientId: otherClient.id }));

    allInvoiceIds = [draftInvoice.id, sentInvoice.id, overdueInvoice.id, paidInvoice.id, cancelledInvoice.id, sameOrgDifferentClient.id];
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { id: { in: allInvoiceIds } } });
    await prisma.client.deleteMany({ where: { id: sameOrgDifferentClient.clientId } });
    await cleanupTestData(fixtures);
  });

  describe("getPortalInvoice — direct detail lookup", () => {
    it("a DRAFT invoice returns null, exactly like a nonexistent id", async () => {
      const result = await getPortalInvoice(fixtures.clientA.id, fixtures.orgA.id, draftInvoice.id);
      expect(result).toBeNull();
    });

    it("SENT, OVERDUE, PAID, and CANCELLED invoices all resolve normally", async () => {
      for (const invoice of [sentInvoice, overdueInvoice, paidInvoice, cancelledInvoice]) {
        const result = await getPortalInvoice(fixtures.clientA.id, fixtures.orgA.id, invoice.id);
        expect(result?.id).toBe(invoice.id);
      }
    });

    it("a same-organization, different-Client invoice fails closed to null", async () => {
      const result = await getPortalInvoice(fixtures.clientA.id, fixtures.orgA.id, sameOrgDifferentClient.id);
      expect(result).toBeNull();
    });

    it("fails closed for a mismatched organizationId even with the right clientId (cross-organization isolation)", async () => {
      // Same real invoice (clientA/orgA), but the caller claims the wrong
      // organizationId — matches authorization.test.ts's own identical
      // proof for verifyPortalAttachmentAccess, applied here to
      // getPortalInvoice.
      const result = await getPortalInvoice(fixtures.clientA.id, fixtures.orgB.id, sentInvoice.id);
      expect(result).toBeNull();
    });
  });

  describe('getPortalInvoices — "all" and "open" filters', () => {
    it('"all": DRAFT is absent; SENT, OVERDUE, PAID, and CANCELLED are all present', async () => {
      const invoices = await getPortalInvoices(fixtures.clientA.id, fixtures.orgA.id, "all");
      expect(invoices.some((i) => i.id === draftInvoice.id)).toBe(false);
      for (const invoice of [sentInvoice, overdueInvoice, paidInvoice, cancelledInvoice]) {
        expect(invoices.some((i) => i.id === invoice.id)).toBe(true);
      }
    });

    it('"open": DRAFT is absent; SENT and OVERDUE are present; PAID and CANCELLED are absent', async () => {
      const invoices = await getPortalInvoices(fixtures.clientA.id, fixtures.orgA.id, "open");
      expect(invoices.some((i) => i.id === draftInvoice.id)).toBe(false);
      expect(invoices.some((i) => i.id === sentInvoice.id)).toBe(true);
      expect(invoices.some((i) => i.id === overdueInvoice.id)).toBe(true);
      expect(invoices.some((i) => i.id === paidInvoice.id)).toBe(false);
      expect(invoices.some((i) => i.id === cancelledInvoice.id)).toBe(false);
    });

    it('"paid": only the PAID invoice is present — unaffected by this correction', async () => {
      const invoices = await getPortalInvoices(fixtures.clientA.id, fixtures.orgA.id, "paid");
      expect(invoices.map((i) => i.id)).toEqual([paidInvoice.id]);
    });

    it("never returns a same-organization, different-Client invoice on any filter", async () => {
      for (const filter of ["all", "open", "paid"] as const) {
        const invoices = await getPortalInvoices(fixtures.clientA.id, fixtures.orgA.id, filter);
        expect(invoices.some((i) => i.id === sameOrgDifferentClient.id)).toBe(false);
      }
    });
  });

  describe("getPortalOverview — recentInvoices and the open-Invoice aggregate", () => {
    it("recentInvoices excludes DRAFT and includes non-DRAFT statuses", async () => {
      const overview = await getPortalOverview(fixtures.clientA.id, fixtures.orgA.id);
      expect(overview.recentInvoices.some((i) => i.id === draftInvoice.id)).toBe(false);
      expect(overview.recentInvoices.some((i) => i.id === sentInvoice.id)).toBe(true);
    });

    it("the open-Invoice aggregate (count and outstanding amount) excludes DRAFT", async () => {
      // Isolate this proof from the other four fixture invoices' amounts by
      // reading straight from Prisma with the exact same predicate the
      // corrected OPEN_INVOICE_STATUSES now expresses, then comparing
      // against the real getPortalOverview() result for internal
      // consistency — this is a behavioral proof, not a re-implementation
      // of the query under test.
      const overview = await getPortalOverview(fixtures.clientA.id, fixtures.orgA.id);
      const expectedOpenAgg = await prisma.invoice.aggregate({
        where: { clientId: fixtures.clientA.id, organizationId: fixtures.orgA.id, status: { in: ["SENT", "OVERDUE"] } },
        _count: { _all: true },
        _sum: { amount: true },
      });
      expect(overview.openInvoicesCount).toBe(expectedOpenAgg._count._all);
      expect(overview.outstandingAmount).toBe(Number(expectedOpenAgg._sum.amount ?? 0));
      // The DRAFT fixture's own $100.00 must never be folded into this sum
      // — a regression here would silently re-inflate the Portal's own
      // "outstanding" KPI with work that was never actually issued.
      expect(overview.outstandingAmount).not.toBe(Number(expectedOpenAgg._sum.amount ?? 0) + 100);
    });
  });

  describe("no side effect of any kind", () => {
    it("reading through every Portal Invoice query surface writes nothing — no Activity, Notification, InvoiceEmailAttempt, InvoicePdfArchiveObject, or PortalDownloadRequest row is created", async () => {
      const before = await Promise.all([
        prisma.activity.count(),
        prisma.notification.count(),
        prisma.invoiceEmailAttempt.count(),
        prisma.invoicePdfArchiveObject.count(),
        prisma.portalDownloadRequest.count(),
      ]);

      await getPortalInvoice(fixtures.clientA.id, fixtures.orgA.id, draftInvoice.id);
      await getPortalInvoice(fixtures.clientA.id, fixtures.orgA.id, sentInvoice.id);
      await getPortalInvoices(fixtures.clientA.id, fixtures.orgA.id, "all");
      await getPortalInvoices(fixtures.clientA.id, fixtures.orgA.id, "open");
      await getPortalOverview(fixtures.clientA.id, fixtures.orgA.id);

      const after = await Promise.all([
        prisma.activity.count(),
        prisma.notification.count(),
        prisma.invoiceEmailAttempt.count(),
        prisma.invoicePdfArchiveObject.count(),
        prisma.portalDownloadRequest.count(),
      ]);

      expect(after).toEqual(before);
    });
  });
});
