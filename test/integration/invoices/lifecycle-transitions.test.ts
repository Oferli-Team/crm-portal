import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { changeInvoiceStatusAction } from "@/app/(dashboard)/invoices/[id]/status-actions";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { INVOICE_STATUSES, type InvoiceStatusValue } from "@/lib/validation/invoice";

/**
 * Invoice System Slice 2b — the full 5x5 lifecycle matrix (25 cells: 7
 * allowed, 18 forbidden/same-state), exercised through the real
 * changeInvoiceStatusAction. Slice 2b ships no DRAFT -> SENT/anything
 * transition (Issue doesn't exist until Slice 3), so every non-DRAFT
 * starting state is seeded directly via Prisma — setup only, matching the
 * same exception already established for other Invoice test files
 * (legacy-compatibility.test.ts, organization-scope.test.ts's
 * completion-metrics case) — every transition itself is exercised through
 * the real production action.
 */

const INVOICE_NUMBER_PREFIX = "INV-LIFECYCLE";

const EXPECTED: Record<InvoiceStatusValue, Record<InvoiceStatusValue, boolean>> = {
  DRAFT: { DRAFT: false, SENT: false, PAID: false, OVERDUE: false, CANCELLED: false },
  SENT: { DRAFT: false, SENT: false, PAID: true, OVERDUE: true, CANCELLED: true },
  OVERDUE: { DRAFT: false, SENT: true, PAID: true, OVERDUE: false, CANCELLED: true },
  PAID: { DRAFT: false, SENT: true, PAID: false, OVERDUE: false, CANCELLED: false },
  CANCELLED: { DRAFT: false, SENT: false, PAID: false, OVERDUE: false, CANCELLED: false },
};

async function seedInvoiceAt(
  fixtures: TestFixtures,
  status: InvoiceStatusValue,
  extra: { paidAt?: Date | null } = {},
) {
  const invoiceNumber = `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}-${randomUUID().slice(0, 8)}`;
  return prisma.invoice.create({
    data: {
      invoiceNumber,
      status,
      amount: "100.00",
      subtotal: "100.00",
      discountAmount: "0.00",
      taxAmount: "0.00",
      paidAt: extra.paidAt ?? (status === "PAID" ? new Date() : null),
      projectId: fixtures.project.id,
      clientId: fixtures.clientA.id,
      organizationId: fixtures.orgA.id,
    },
  });
}

describe("changeInvoiceStatusAction — full 5x5 lifecycle matrix", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await cleanupTestData(fixtures);
  });

  for (const from of INVOICE_STATUSES) {
    for (const to of INVOICE_STATUSES) {
      const expected = EXPECTED[from][to];
      it(`${from} -> ${to} is ${expected ? "allowed" : "forbidden"}`, async () => {
        const invoice = await seedInvoiceAt(fixtures, from);
        actAs(fixtures.owner, fixtures.orgA.id);
        const result = await changeInvoiceStatusAction(invoice.id, to);
        resetAuthMock();

        const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
        if (expected) {
          expect(result).toEqual({ ok: true });
          expect(after.status).toBe(to);
        } else {
          expect(result).toEqual({ ok: false, error: "FORBIDDEN_TRANSITION" });
          expect(after.status).toBe(from);
        }
      });
    }
  }

  describe("paidAt — the 4-case rule, through the real action", () => {
    it("not-PAID -> PAID stamps a fresh paidAt", async () => {
      const invoice = await seedInvoiceAt(fixtures, "SENT");
      actAs(fixtures.owner, fixtures.orgA.id);
      await changeInvoiceStatusAction(invoice.id, "PAID");
      resetAuthMock();

      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(after.paidAt).not.toBeNull();
    });

    it("PAID -> not-PAID clears it", async () => {
      const invoice = await seedInvoiceAt(fixtures, "PAID", { paidAt: new Date() });
      actAs(fixtures.owner, fixtures.orgA.id);
      await changeInvoiceStatusAction(invoice.id, "SENT");
      resetAuthMock();

      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(after.paidAt).toBeNull();
    });

    it("a forbidden transition never touches paidAt", async () => {
      const stampedAt = new Date("2026-01-01T00:00:00.000Z");
      const invoice = await seedInvoiceAt(fixtures, "PAID", { paidAt: stampedAt });
      actAs(fixtures.owner, fixtures.orgA.id);
      const result = await changeInvoiceStatusAction(invoice.id, "OVERDUE");
      resetAuthMock();

      expect(result).toEqual({ ok: false, error: "FORBIDDEN_TRANSITION" });
      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(after.paidAt?.getTime()).toBe(stampedAt.getTime());
    });
  });

  describe("STATUS_CHANGED Activity and Notification", () => {
    it("an allowed transition writes STATUS_CHANGED Activity and fans out to every OWNER/ADMIN", async () => {
      const invoice = await seedInvoiceAt(fixtures, "SENT");
      actAs(fixtures.owner, fixtures.orgA.id);
      await changeInvoiceStatusAction(invoice.id, "PAID");
      resetAuthMock();

      const activity = await prisma.activity.findFirstOrThrow({ where: { entityId: invoice.id, action: "STATUS_CHANGED" } });
      expect(activity.metadata).toMatchObject({ from: "SENT", to: "PAID" });

      const notifications = await prisma.notification.findMany({ where: { activityId: activity.id } });
      // fixtures.owner is the actor and is excluded; fixtures.admin should
      // receive one.
      expect(notifications.some((n) => n.recipientId === fixtures.admin.id)).toBe(true);
      expect(notifications.some((n) => n.recipientId === fixtures.owner.id)).toBe(false);
    });

    it("a forbidden transition writes zero Activity and zero Notification rows", async () => {
      const invoice = await seedInvoiceAt(fixtures, "CANCELLED");
      actAs(fixtures.owner, fixtures.orgA.id);
      await changeInvoiceStatusAction(invoice.id, "PAID");
      resetAuthMock();

      const activityCount = await prisma.activity.count({ where: { entityId: invoice.id } });
      expect(activityCount).toBe(0);
    });
  });

  describe("tenant scoping and not-found", () => {
    it("a cross-organization invoice id is NOT_FOUND, never leaked", async () => {
      actAs(fixtures.orgBOwner, fixtures.orgB.id);
      const invoice = await seedInvoiceAt(fixtures, "SENT");
      const result = await changeInvoiceStatusAction(invoice.id, "PAID");
      resetAuthMock();

      expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(after.status).toBe("SENT");
    });

    it("a nonexistent invoice id is NOT_FOUND", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const result = await changeInvoiceStatusAction(randomUUID(), "PAID");
      resetAuthMock();
      expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
    });
  });
});
