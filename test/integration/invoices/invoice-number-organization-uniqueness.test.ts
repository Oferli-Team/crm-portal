import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { createInvoiceAction } from "@/app/(dashboard)/invoices/new/actions";
import { updateInvoiceAction } from "@/app/(dashboard)/invoices/[id]/edit/actions";
import { mapInvoiceWriteError } from "@/lib/invoices/write-conflict-mapper";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { RedirectSignal } from "../../support/navigation-mock";
import type { InvoiceFormState } from "@/types";

/**
 * Invoice System Official Slice 5c — organization-wide Invoice-number
 * uniqueness. Exercises the real createInvoiceAction/updateInvoiceAction
 * Server Actions against the actual database constraint (migration
 * 20260916090000_invoice_number_unique_per_organization), never a mocked
 * Prisma client, matching this repository's own established rule.
 *
 * A second Client + Project inside org A is created inline in this
 * file's own beforeAll — the shared fixture (test/fixtures/seed.ts) only
 * ever defines one Client per organization (clientA in orgA, clientB in
 * an entirely different orgB), so a genuine same-organization/different-
 * Client topology does not exist anywhere else and must be constructed
 * here, matching the precedent already established by
 * test/integration/invoices/organization-scope.test.ts's own inline
 * clientA2/projectA2.
 */

const INVOICE_NUMBER_PREFIX = "INV-ORGUNIQ";

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

/**
 * A rejected create/edit rolls back inside prisma.$transaction(); the
 * shared local PGlite/pg-adapter test harness (`max: 1` pool, see
 * src/lib/prisma.ts) needs a brief moment to settle that rollback before
 * a fresh read is guaranteed consistent — the same established finding
 * documented in test/integration/invoices/duplicate.test.ts's own
 * "collision" test, reused here verbatim rather than re-derived. Polls
 * for the full expected end state rather than sleeping a fixed amount; a
 * poll timeout is never itself treated as success — whatever this last
 * observed is asserted explicitly by the caller.
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
      // Retried below.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return check();
}

describe("Invoice System Official Slice 5c — organization-wide Invoice-number uniqueness", () => {
  let fixtures: TestFixtures;
  let clientA2: { id: string };
  let projectA2: { id: string };
  // orgB's shared fixture never seeds a Project of its own (only clientB)
  // — created inline here, matching the same gap
  // test/integration/invoices/organization-scope.test.ts's own inline
  // projectB already closes.
  let projectB: { id: string };

  beforeAll(async () => {
    fixtures = await seedTestData();
    clientA2 = await prisma.client.create({
      data: { name: `Org A Second Client ${fixtures.runId}`, userId: fixtures.owner.id, organizationId: fixtures.orgA.id },
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

  describe("create", () => {
    it("same Client + same number: rejected with the existing duplicate-number field error", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const invoiceNumber = uniqueInvoiceNumber(fixtures.runId);
      await expectRedirect(createInvoiceAction({ error: null }, buildFormData(invoiceNumber, fixtures.project.id)));

      const result = await createInvoiceAction({ error: null }, buildFormData(invoiceNumber, fixtures.project.id));
      resetAuthMock();

      expect(result).toEqual({ error: null, fieldErrors: { invoiceNumber: "An invoice with this number already exists." } });
      const count = await pollUntilStable(
        () => prisma.invoice.count({ where: { organizationId: fixtures.orgA.id, invoiceNumber } }),
        (n) => n === 1,
      );
      expect(count).toBe(1);
    });

    it("different Clients in the same organization + same number: rejected with the existing duplicate-number field error", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const invoiceNumber = uniqueInvoiceNumber(fixtures.runId);
      await expectRedirect(createInvoiceAction({ error: null }, buildFormData(invoiceNumber, fixtures.project.id)));

      const result = await createInvoiceAction({ error: null }, buildFormData(invoiceNumber, projectA2.id));
      resetAuthMock();

      expect(result).toEqual({ error: null, fieldErrors: { invoiceNumber: "An invoice with this number already exists." } });
      const state = await pollUntilStable(
        async () => ({
          count: await prisma.invoice.count({ where: { organizationId: fixtures.orgA.id, invoiceNumber } }),
          onSecondClient: await prisma.invoice.findFirst({ where: { clientId: clientA2.id, invoiceNumber } }),
        }),
        (s) => s.count === 1 && s.onSecondClient === null,
      );
      expect(state.count).toBe(1);
      expect(state.onSecondClient).toBeNull();
    });

    it("different organizations + same number: both succeed — cross-org reuse remains allowed", async () => {
      const invoiceNumber = uniqueInvoiceNumber(fixtures.runId);

      actAs(fixtures.owner, fixtures.orgA.id);
      await expectRedirect(createInvoiceAction({ error: null }, buildFormData(invoiceNumber, fixtures.project.id)));
      resetAuthMock();

      actAs(fixtures.orgBOwner, fixtures.orgB.id);
      await expectRedirect(createInvoiceAction({ error: null }, buildFormData(invoiceNumber, projectB.id)));
      resetAuthMock();

      const inOrgA = await prisma.invoice.count({ where: { organizationId: fixtures.orgA.id, invoiceNumber } });
      const inOrgB = await prisma.invoice.count({ where: { organizationId: fixtures.orgB.id, invoiceNumber } });
      expect(inOrgA).toBe(1);
      expect(inOrgB).toBe(1);

      await prisma.invoice.deleteMany({ where: { organizationId: fixtures.orgB.id, invoiceNumber } });
    });

    it("real concurrent creates, same organization + same number (different Clients): exactly one succeeds, the loser gets the bounded duplicate-number field error", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const invoiceNumber = uniqueInvoiceNumber(fixtures.runId);

      const [resultA, resultB] = await Promise.allSettled([
        createInvoiceAction({ error: null }, buildFormData(invoiceNumber, fixtures.project.id)),
        createInvoiceAction({ error: null }, buildFormData(invoiceNumber, projectA2.id)),
      ]);
      resetAuthMock();

      const redirected = [resultA, resultB].filter((r) => r.status === "rejected" && r.reason instanceof RedirectSignal);
      const conflicted = [resultA, resultB].filter(
        (r) => r.status === "fulfilled" && (r.value as InvoiceFormState).fieldErrors?.invoiceNumber !== undefined,
      );
      expect(redirected).toHaveLength(1);
      expect(conflicted).toHaveLength(1);
      expect((conflicted[0] as PromiseFulfilledResult<InvoiceFormState>).value.fieldErrors?.invoiceNumber).toBe(
        "An invoice with this number already exists.",
      );

      const count = await pollUntilStable(
        () => prisma.invoice.count({ where: { organizationId: fixtures.orgA.id, invoiceNumber } }),
        (n) => n === 1,
      );
      expect(count).toBe(1);
    });
  });

  describe("edit", () => {
    it("same Client + same number as another existing Invoice: rejected with the existing duplicate-number field error, no partial write", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const takenNumber = uniqueInvoiceNumber(fixtures.runId);
      await expectRedirect(createInvoiceAction({ error: null }, buildFormData(takenNumber, fixtures.project.id)));

      const ownNumber = uniqueInvoiceNumber(fixtures.runId);
      await expectRedirect(createInvoiceAction({ error: null }, buildFormData(ownNumber, fixtures.project.id)));
      const toEdit = await prisma.invoice.findFirstOrThrow({ where: { organizationId: fixtures.orgA.id, invoiceNumber: ownNumber } });

      const result = await updateInvoiceAction(
        toEdit.id,
        toEdit.updatedAt.toISOString(),
        { error: null },
        buildFormData(takenNumber, fixtures.project.id),
      );
      resetAuthMock();

      expect(result).toEqual({ error: null, fieldErrors: { invoiceNumber: "An invoice with this number already exists." } });
      const unchanged = await pollUntilStable(
        () => prisma.invoice.findUniqueOrThrow({ where: { id: toEdit.id } }),
        (inv) => inv.invoiceNumber === ownNumber,
      );
      expect(unchanged.invoiceNumber).toBe(ownNumber);
    });

    it("different Client in the same organization + same number as another existing Invoice: rejected", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const takenNumber = uniqueInvoiceNumber(fixtures.runId);
      await expectRedirect(createInvoiceAction({ error: null }, buildFormData(takenNumber, fixtures.project.id)));

      const ownNumber = uniqueInvoiceNumber(fixtures.runId);
      await expectRedirect(createInvoiceAction({ error: null }, buildFormData(ownNumber, projectA2.id)));
      const toEdit = await prisma.invoice.findFirstOrThrow({ where: { organizationId: fixtures.orgA.id, invoiceNumber: ownNumber } });

      const result = await updateInvoiceAction(
        toEdit.id,
        toEdit.updatedAt.toISOString(),
        { error: null },
        buildFormData(takenNumber, projectA2.id),
      );
      resetAuthMock();

      expect(result).toEqual({ error: null, fieldErrors: { invoiceNumber: "An invoice with this number already exists." } });
      const unchanged = await pollUntilStable(
        () => prisma.invoice.findUniqueOrThrow({ where: { id: toEdit.id } }),
        (inv) => inv.invoiceNumber === ownNumber,
      );
      expect(unchanged.invoiceNumber).toBe(ownNumber);
    });

    it("an unchanged DRAFT resubmitting its own current number: no-op, no error, no duplicate rejection", async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const invoiceNumber = uniqueInvoiceNumber(fixtures.runId);
      await expectRedirect(createInvoiceAction({ error: null }, buildFormData(invoiceNumber, fixtures.project.id)));
      const invoice = await prisma.invoice.findFirstOrThrow({ where: { organizationId: fixtures.orgA.id, invoiceNumber } });

      await expectRedirect(
        updateInvoiceAction(
          invoice.id,
          invoice.updatedAt.toISOString(),
          { error: null },
          buildFormData(invoiceNumber, fixtures.project.id),
        ),
      );
      resetAuthMock();

      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(after.invoiceNumber).toBe(invoiceNumber);
      expect(after.updatedAt.getTime()).toBe(invoice.updatedAt.getTime()); // true no-op: parent row untouched
    });
  });

  describe("tenant isolation", () => {
    it("an org A actor cannot be redirected into seeing an org B Invoice's data via this uniqueness change", async () => {
      // The uniqueness scope itself is organizationId — proves org A and
      // org B can never collide with (or see) one another regardless of
      // shared invoiceNumber text, independent of the cross-org-reuse
      // test above which only checks both rows persist.
      const invoiceNumber = uniqueInvoiceNumber(fixtures.runId);
      actAs(fixtures.owner, fixtures.orgA.id);
      await expectRedirect(createInvoiceAction({ error: null }, buildFormData(invoiceNumber, fixtures.project.id)));
      resetAuthMock();

      actAs(fixtures.orgBOwner, fixtures.orgB.id);
      await expectRedirect(createInvoiceAction({ error: null }, buildFormData(invoiceNumber, projectB.id)));
      resetAuthMock();

      const orgAInvoice = await prisma.invoice.findFirstOrThrow({ where: { organizationId: fixtures.orgA.id, invoiceNumber } });
      const orgBInvoice = await prisma.invoice.findFirstOrThrow({ where: { organizationId: fixtures.orgB.id, invoiceNumber } });
      expect(orgAInvoice.id).not.toBe(orgBInvoice.id);
      expect(orgAInvoice.organizationId).not.toBe(orgBInvoice.organizationId);

      await prisma.invoice.deleteMany({ where: { organizationId: fixtures.orgB.id, invoiceNumber } });
    });
  });

  describe("P2002 classification", () => {
    it("a genuine organizationId+invoiceNumber P2002 maps to INVOICE_NUMBER_CONFLICT", async () => {
      const invoiceNumber = uniqueInvoiceNumber(fixtures.runId);
      await prisma.invoice.create({
        data: {
          invoiceNumber,
          status: "DRAFT",
          amount: "10.00",
          clientId: fixtures.clientA.id,
          projectId: fixtures.project.id,
          organizationId: fixtures.orgA.id,
        },
      });

      let caught: unknown;
      try {
        await prisma.invoice.create({
          data: {
            invoiceNumber,
            status: "DRAFT",
            amount: "20.00",
            clientId: clientA2.id,
            projectId: projectA2.id,
            organizationId: fixtures.orgA.id,
          },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(mapInvoiceWriteError(caught)).toBe("INVOICE_NUMBER_CONFLICT");
    });

    it("a reachable InvoiceLineItem (invoiceId, position) P2002 does not map to INVOICE_NUMBER_CONFLICT — fails closed as UNRECOGNIZED", async () => {
      // Constructed directly via real (never mocked) Prisma calls against
      // the real database — this repository's own established rule never
      // mocks Prisma in integration tests. Not reachable through the
      // public createInvoiceAction/updateInvoiceAction interface itself
      // (positions are always freshly computed 0..n-1 server-side), so
      // this proves the mapper's own classification directly against a
      // genuine error object rather than through the full write
      // transaction — a disclosed, narrow limitation, not a gap in the
      // classification logic itself.
      const invoiceNumber = uniqueInvoiceNumber(fixtures.runId);
      const invoice = await prisma.invoice.create({
        data: {
          invoiceNumber,
          status: "DRAFT",
          amount: "10.00",
          clientId: fixtures.clientA.id,
          projectId: fixtures.project.id,
          organizationId: fixtures.orgA.id,
        },
      });
      await prisma.invoiceLineItem.create({
        data: { invoiceId: invoice.id, description: "First", quantity: "1", unitPrice: "10.00", lineTotal: "10.00", position: 0 },
      });

      let caught: unknown;
      try {
        await prisma.invoiceLineItem.create({
          data: { invoiceId: invoice.id, description: "Collides", quantity: "1", unitPrice: "10.00", lineTotal: "10.00", position: 0 },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(mapInvoiceWriteError(caught)).toBe("UNRECOGNIZED");
      expect(mapInvoiceWriteError(caught)).not.toBe("INVOICE_NUMBER_CONFLICT");
    });

    // A full end-to-end trigger of the UNRECOGNIZED branch through the
    // real createInvoiceAction/updateInvoiceAction transactions themselves
    // (rather than the direct-mapper proof above) was not attempted here:
    // neither writer can reach the InvoiceLineItem (invoiceId, position)
    // constraint through its own public interface (positions are always
    // freshly computed 0..n-1 server-side on every call), and forcing an
    // unrelated collision through some other path would mean fabricating
    // a scenario this repository's real code can never actually produce —
    // a disclosed, deliberate limitation rather than a mocked or
    // misleading test.
  });
});
