import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createInvoiceAction } from "@/app/(dashboard)/invoices/new/actions";
import { updateInvoiceAction } from "@/app/(dashboard)/invoices/[id]/edit/actions";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { RedirectSignal } from "../../support/navigation-mock";

/**
 * Invoice System Slice 2b — page-version DRAFT edit concurrency. Proves
 * the `expectedUpdatedAt` guard closes the "two edits from the same
 * rendered page" race a status-only or fresh-in-transaction-read guard
 * cannot. Both concurrent submissions below are built from the exact same
 * `T0` (the invoice's `updatedAt` as it existed before either call
 * starts) — never from a value either call reads for itself — so the
 * test is deterministic regardless of which of Postgres's two `UPDATE`s
 * actually runs first. No sleeps, barriers, or production test hooks.
 *
 * The winning write's new `updatedAt` is computed explicitly by the
 * action itself as `max(Date.now(), expectedDate + 1ms)` — never Prisma's
 * implicit `@updatedAt` behavior alone — so the loser's guarded `WHERE
 * updatedAt = T0` is deterministically guaranteed to match zero rows once
 * the winner commits, regardless of millisecond-level clock granularity
 * or Prisma happening to pick a distinct timestamp. The dedicated
 * "strictly monotonic" test below proves this directly by starting from
 * an updatedAt set *ahead* of the real wall clock.
 */

const INVOICE_NUMBER_PREFIX = "INV-CONFLICT";

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
  });
}

describe("updateInvoiceAction — page-version concurrency", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await cleanupTestData(fixtures);
  });

  it("two concurrent submissions from the same rendered page version: exactly one wins", async () => {
    const draft = await createDraft(fixtures);
    const T0 = draft.updatedAt.toISOString();
    actAs(fixtures.owner, fixtures.orgA.id);

    const [resultA, resultB] = await Promise.allSettled([
      updateInvoiceAction(draft.id, T0, { error: null }, buildFormData(draft.invoiceNumber, fixtures.project.id, { amount: "111.00" })),
      updateInvoiceAction(draft.id, T0, { error: null }, buildFormData(draft.invoiceNumber, fixtures.project.id, { amount: "222.00" })),
    ]);
    resetAuthMock();

    const redirected = [resultA, resultB].filter((r) => r.status === "rejected" && r.reason instanceof RedirectSignal);
    const conflicted = [resultA, resultB].filter(
      (r) => r.status === "fulfilled" && (r.value as { error: string | null }).error !== null,
    );
    expect(redirected).toHaveLength(1);
    expect(conflicted).toHaveLength(1);

    const final = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } });
    expect(["111.00", "222.00"]).toContain(final.amount.toFixed(2));
    // Deterministically strictly greater — guaranteed by the action's own
    // explicit max(Date.now(), expectedDate+1ms) computation, not by
    // Prisma happening to pick a distinct millisecond for the two writes.
    expect(final.updatedAt.getTime()).toBeGreaterThan(draft.updatedAt.getTime());

    const activities = await prisma.activity.count({ where: { entityId: draft.id, action: "UPDATED" } });
    expect(activities).toBe(1);

    const lineItems = await prisma.invoiceLineItem.count({ where: { invoiceId: draft.id } });
    expect(lineItems).toBe(0); // both submissions were flat — no partial itemized leftovers either way
  });

  it("the new updatedAt is strictly greater than the page version even when the real clock is behind it", async () => {
    const draft = await createDraft(fixtures);
    // A version deliberately set AHEAD of the real wall clock — proves
    // "a successful UPDATE always produces a value different from
    // expectedDate" is not being assumed from Prisma's implicit
    // @updatedAt behavior (which would just stamp the current,
    // real-clock time — itself BEHIND this fixture's T0, and therefore
    // NOT strictly greater). Only the action's own explicit
    // max(Date.now(), expectedDate + 1ms) computation guarantees
    // monotonicity here.
    const farFutureT0 = new Date(Date.now() + 10 * 60 * 60 * 1000);
    await prisma.invoice.update({ where: { id: draft.id }, data: { updatedAt: farFutureT0 } });

    actAs(fixtures.owner, fixtures.orgA.id);
    await expectRedirect(
      updateInvoiceAction(
        draft.id,
        farFutureT0.toISOString(),
        { error: null },
        buildFormData(draft.invoiceNumber, fixtures.project.id, { amount: "321.00" }),
      ),
    );
    resetAuthMock();

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } });
    expect(after.amount.toFixed(2)).toBe("321.00");
    expect(after.updatedAt.getTime()).toBeGreaterThan(farFutureT0.getTime());
    // Real Date.now() at commit time is still behind farFutureT0 — proves
    // the value came from expectedDate+1ms, not from the real clock alone.
    expect(after.updatedAt.getTime()).toBeGreaterThan(Date.now());

    const activities = await prisma.activity.count({ where: { entityId: draft.id, action: "UPDATED" } });
    expect(activities).toBe(1);
  });

  it("a stale T0 submitted after a prior edit already committed returns a conflict", async () => {
    const draft = await createDraft(fixtures);
    const T0 = draft.updatedAt.toISOString();
    actAs(fixtures.owner, fixtures.orgA.id);

    await expectRedirect(
      updateInvoiceAction(draft.id, T0, { error: null }, buildFormData(draft.invoiceNumber, fixtures.project.id, { amount: "50.00" })),
    );

    const stale = await updateInvoiceAction(
      draft.id,
      T0,
      { error: null },
      buildFormData(draft.invoiceNumber, fixtures.project.id, { amount: "999.00" }),
    );
    resetAuthMock();

    expect(stale.error).toBe("This invoice was changed elsewhere — please refresh and try again.");
    const final = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } });
    expect(final.amount.toFixed(2)).toBe("50.00");
  });

  it("a fresh T1 (re-read after a prior commit) succeeds", async () => {
    const draft = await createDraft(fixtures);
    const T0 = draft.updatedAt.toISOString();
    actAs(fixtures.owner, fixtures.orgA.id);

    await expectRedirect(
      updateInvoiceAction(draft.id, T0, { error: null }, buildFormData(draft.invoiceNumber, fixtures.project.id, { amount: "50.00" })),
    );
    const afterFirst = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } });
    const T1 = afterFirst.updatedAt.toISOString();

    await expectRedirect(
      updateInvoiceAction(draft.id, T1, { error: null }, buildFormData(draft.invoiceNumber, fixtures.project.id, { amount: "75.00" })),
    );
    resetAuthMock();

    const final = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } });
    expect(final.amount.toFixed(2)).toBe("75.00");
  });

  it("a true no-op using the current version does not bump updatedAt or create Activity", async () => {
    const draft = await createDraft(fixtures, { amount: "60.00" });
    actAs(fixtures.owner, fixtures.orgA.id);

    await expectRedirect(
      updateInvoiceAction(
        draft.id,
        draft.updatedAt.toISOString(),
        { error: null },
        buildFormData(draft.invoiceNumber, fixtures.project.id, { amount: "60.00" }),
      ),
    );
    resetAuthMock();

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } });
    expect(after.updatedAt.getTime()).toBe(draft.updatedAt.getTime());
    const activities = await prisma.activity.count({ where: { entityId: draft.id } });
    expect(activities).toBe(1); // only the original CREATED
  });

  it("an invalid expectedUpdatedAt string is rejected before any DB write", async () => {
    const draft = await createDraft(fixtures);
    actAs(fixtures.owner, fixtures.orgA.id);

    const result = await updateInvoiceAction(
      draft.id,
      "not-a-real-iso-timestamp",
      { error: null },
      buildFormData(draft.invoiceNumber, fixtures.project.id, { amount: "999.00" }),
    );
    resetAuthMock();

    expect(result.error).toBeTruthy();
    const unchanged = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } });
    expect(unchanged.amount.toFixed(2)).toBe(draft.amount.toFixed(2));
  });
});
