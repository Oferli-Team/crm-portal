import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/invoices/[id]/pdf/route";
import { buildInvoicePdfStoragePath, createInvoicePdfSignedUrl } from "@/lib/invoices/pdf/storage";
import { checkRateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { RedirectSignal } from "../../support/navigation-mock";

/**
 * Invoice System Official Slice 3, sub-PR 3c — the staff signed PDF
 * download Route Handler. Calls the real, unmodified GET export directly
 * with real seeded Prisma data, the real getCurrentUserOrganization()
 * resolution, and the real classifyInvoiceArchival()/
 * buildInvoicePdfStoragePath() logic. Only the two unavoidable external/
 * control boundaries are mocked, file-locally (this file's own vi.mock()
 * calls take precedence over test/integration/setup-mocks.ts's own
 * @/lib/rate-limit registration for this file only — standard per-file
 * Vitest module-mock override, not a change to the shared harness):
 *  - createInvoicePdfSignedUrl() (@/lib/invoices/pdf/storage) — no real
 *    Storage is ever contacted; success/failure/call-ordering are fully
 *    controllable per test. buildInvoicePdfStoragePath() and every other
 *    export of this module stay real (spread from importOriginal), since
 *    the route's own canonical-identity rebuild must exercise the real
 *    implementation.
 *  - checkRateLimit() (@/lib/rate-limit) — the limited branch is
 *    controllable per test; every other export (INVOICE_PDF_DOWNLOAD_LIMIT,
 *    RATE_LIMIT_MESSAGE, ...) stays real.
 */
vi.mock("@/lib/invoices/pdf/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/invoices/pdf/storage")>();
  return { ...actual, createInvoicePdfSignedUrl: vi.fn() };
});

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, checkRateLimit: vi.fn() };
});

const mockedSign = vi.mocked(createInvoicePdfSignedUrl);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);

const DEFAULT_SIGNED_URL = "https://example.test/signed-invoice.pdf";

beforeEach(() => {
  mockedSign.mockReset().mockResolvedValue({ ok: true, url: DEFAULT_SIGNED_URL });
  mockedCheckRateLimit.mockReset().mockReturnValue({ limited: false });
});

afterEach(() => {
  resetAuthMock();
});

function pdfRequest(id: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/invoices/${id}/pdf`), {
    params: Promise.resolve({ id }),
  });
}

const INVOICE_NUMBER_PREFIX = "INV-PDF-DL";
const FIXED_NOW = new Date("2026-08-18T12:00:00.000Z");

const VALID_ISSUER_SNAPSHOT = {
  schemaVersion: 1,
  legalName: "Test Org A",
  address: { streetAddress: null, city: null, state: null, postalCode: null },
  country: null,
  taxId: null,
  supportEmail: null,
  phone: null,
  website: null,
  brandColor: null,
  payment: null,
  logo: { included: false, reason: "no_logo_configured" },
};

const VALID_RECIPIENT_SNAPSHOT = {
  schemaVersion: 1,
  billingName: "Test Client A",
  email: null,
  address: { streetAddress: null, city: null, state: null, postalCode: null },
  country: null,
  taxId: null,
};

type LedgerMode = "matching" | "none" | "wrongVersion" | "wrongStatus" | "wrongPath" | "nullReferencedAt" | "mismatchedIdentity";

async function seedArchivedInvoice(
  fixtures: TestFixtures,
  opts: { documentVersion?: number; ledger?: LedgerMode } = {},
) {
  const documentVersion = opts.documentVersion ?? 1;
  const ledgerMode = opts.ledger ?? "matching";
  const invoiceId = randomUUID();
  const archiveId = randomUUID();
  const path = buildInvoicePdfStoragePath({
    organizationId: fixtures.orgA.id,
    invoiceId,
    documentVersion,
    archiveId,
  });

  const invoice = await prisma.invoice.create({
    data: {
      id: invoiceId,
      invoiceNumber: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}-${invoiceId.slice(0, 8)}`,
      status: "SENT",
      amount: "100.00",
      subtotal: "100.00",
      discountAmount: "0.00",
      taxAmount: "0.00",
      finalizedAt: FIXED_NOW,
      pdfGeneratedAt: FIXED_NOW,
      issuerSnapshot: VALID_ISSUER_SNAPSHOT,
      recipientSnapshot: VALID_RECIPIENT_SNAPSHOT,
      documentVersion,
      pdfStoragePath: path,
      projectId: fixtures.project.id,
      clientId: fixtures.clientA.id,
      organizationId: fixtures.orgA.id,
    },
  });

  if (ledgerMode !== "none") {
    // mismatchedIdentity: every one of the six predicates matches (the
    // ledger's own storagePath is textually identical to invoice.
    // pdfStoragePath), but the row's own id (used as archiveId when
    // reconstructing the identity) is a DIFFERENT uuid than the one
    // actually embedded in that shared path — id is not, and cannot be,
    // one of the six query predicates. This is the one case where the
    // ledger row is genuinely returned by the six-predicate query, and
    // the route's own post-fetch canonical-path rebuild is the only thing
    // that catches it.
    const ledgerArchiveId = ledgerMode === "mismatchedIdentity" ? randomUUID() : archiveId;
    const ledgerStoragePath =
      ledgerMode === "wrongPath"
        ? buildInvoicePdfStoragePath({ organizationId: fixtures.orgA.id, invoiceId, documentVersion, archiveId: randomUUID() })
        : path;

    await prisma.invoicePdfArchiveObject.create({
      data: {
        id: ledgerArchiveId,
        organizationId: fixtures.orgA.id,
        invoiceId,
        documentVersion: ledgerMode === "wrongVersion" ? documentVersion + 1 : documentVersion,
        storagePath: ledgerStoragePath,
        status: ledgerMode === "wrongStatus" ? "PENDING_UPLOAD" : "REFERENCED",
        referencedAt: ledgerMode === "nullReferencedAt" ? null : FIXED_NOW,
      },
    });
  }

  return { invoice, archiveId, path };
}

async function seedDraftInvoice(fixtures: TestFixtures) {
  return prisma.invoice.create({
    data: {
      invoiceNumber: `${INVOICE_NUMBER_PREFIX}-DRAFT-${fixtures.runId}-${randomUUID().slice(0, 8)}`,
      status: "DRAFT",
      amount: "10.00",
      subtotal: "10.00",
      discountAmount: "0.00",
      taxAmount: "0.00",
      projectId: fixtures.project.id,
      clientId: fixtures.clientA.id,
      organizationId: fixtures.orgA.id,
    },
  });
}

async function seedLegacyEligibleInvoice(fixtures: TestFixtures) {
  return prisma.invoice.create({
    data: {
      invoiceNumber: `${INVOICE_NUMBER_PREFIX}-LEGACY-${fixtures.runId}-${randomUUID().slice(0, 8)}`,
      status: "SENT",
      amount: "10.00",
      subtotal: "10.00",
      discountAmount: "0.00",
      taxAmount: "0.00",
      // finalizedAt/pdfStoragePath/pdfGeneratedAt/issuerSnapshot/
      // recipientSnapshot are all left null by construction — a real
      // pre-Slice-3 historical row.
      projectId: fixtures.project.id,
      clientId: fixtures.clientA.id,
      organizationId: fixtures.orgA.id,
    },
  });
}

async function seedInvariantViolationInvoice(
  fixtures: TestFixtures,
  reason: "draft_with_archive_fields" | "incomplete_archive_fields" | "snapshot_unparseable",
) {
  const base = {
    invoiceNumber: `${INVOICE_NUMBER_PREFIX}-INVARIANT-${reason}-${fixtures.runId}-${randomUUID().slice(0, 8)}`,
    amount: "10.00",
    subtotal: "10.00",
    discountAmount: "0.00",
    taxAmount: "0.00",
    projectId: fixtures.project.id,
    clientId: fixtures.clientA.id,
    organizationId: fixtures.orgA.id,
  };

  if (reason === "draft_with_archive_fields") {
    // DRAFT status + any single non-null archive field (never needs all
    // five to trip this — classifyInvoiceArchival() only requires "not
    // allNull").
    return prisma.invoice.create({ data: { ...base, status: "DRAFT", finalizedAt: FIXED_NOW } });
  }

  if (reason === "incomplete_archive_fields") {
    // non-DRAFT + a strict subset of the five archive fields populated.
    return prisma.invoice.create({ data: { ...base, status: "SENT", finalizedAt: FIXED_NOW } });
  }

  // snapshot_unparseable: non-DRAFT + all five archive fields populated,
  // but the snapshot JSON does not satisfy parseIssuerSnapshot()/
  // parseRecipientSnapshot()'s own strict shape contract.
  return prisma.invoice.create({
    data: {
      ...base,
      status: "SENT",
      finalizedAt: FIXED_NOW,
      pdfGeneratedAt: FIXED_NOW,
      pdfStoragePath: `not-a-real-archive-path-${randomUUID()}`,
      issuerSnapshot: { garbage: true },
      recipientSnapshot: { garbage: true },
    },
  });
}

async function countScopedRows(organizationId: string) {
  const [invoices, lineItems, ledgerObjects, activities, notifications] = await Promise.all([
    prisma.invoice.count({ where: { organizationId } }),
    prisma.invoiceLineItem.count({ where: { invoice: { organizationId } } }),
    prisma.invoicePdfArchiveObject.count({ where: { organizationId } }),
    prisma.activity.count({ where: { organizationId } }),
    prisma.notification.count({ where: { organizationId } }),
  ]);
  return { invoices, lineItems, ledgerObjects, activities, notifications };
}

/**
 * Normalizes exactly the two field shapes that would otherwise make a
 * structurally-identical row compare unequal across two separate reads:
 * a Prisma.Decimal (compared by its exact string representation) and a
 * Date (compared by its exact ISO string). Every other field — including
 * every Json column (issuerSnapshot/recipientSnapshot/metadata), every
 * nullable field, and every plain string/number/boolean/enum — is left
 * completely untouched, so no meaningful field is ever erased or
 * collapsed by this normalization.
 */
function normalizeRow<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (value instanceof Date) return [key, value.toISOString()];
      if (value !== null && typeof value === "object" && typeof (value as { toFixed?: unknown }).toFixed === "function") {
        return [key, String(value)];
      }
      return [key, value];
    }),
  );
}

/**
 * Exact, deterministically-ordered state for one target Invoice and every
 * row the route could conceivably touch — not merely a count. Used by the
 * zero-write invariant block below: before/after equality here is a
 * strictly stronger claim than countScopedRows()'s own row-count check,
 * since it also catches an in-place field mutation on an existing row
 * that a count alone could never detect.
 */
async function captureInvoiceState(invoiceId: string, organizationId: string) {
  const [invoice, lineItems, ledgerRows, activities, notifications] = await Promise.all([
    prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } }),
    prisma.invoiceLineItem.findMany({ where: { invoiceId }, orderBy: [{ position: "asc" }, { id: "asc" }] }),
    prisma.invoicePdfArchiveObject.findMany({ where: { invoiceId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    // Activity has no direct Invoice foreign key — organizationId +
    // entityType + entityId is the same real, existing scoping every
    // other Activity query in this codebase already uses (see
    // issue-invoice.ts's own createActivity() call).
    prisma.activity.findMany({
      where: { organizationId, entityType: "INVOICE", entityId: invoiceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    // Notification likewise carries its own real entityType/entityId
    // columns (prisma/schema.prisma's Notification model) — not an
    // invented relationship, the same columns Activity's own entityType/
    // entityId use, scoped the identical way.
    prisma.notification.findMany({
      where: { organizationId, entityType: "INVOICE", entityId: invoiceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);

  return {
    invoice: normalizeRow(invoice as unknown as Record<string, unknown>),
    lineItems: lineItems.map((row) => normalizeRow(row as unknown as Record<string, unknown>)),
    ledgerRows: ledgerRows.map((row) => normalizeRow(row as unknown as Record<string, unknown>)),
    activities: activities.map((row) => normalizeRow(row as unknown as Record<string, unknown>)),
    notifications: notifications.map((row) => normalizeRow(row as unknown as Record<string, unknown>)),
  };
}

describe("GET /api/invoices/[id]/pdf — Invoice System Official Slice 3, sub-PR 3c", () => {
  let fixtures: TestFixtures;
  let projectB: { id: string };

  beforeAll(async () => {
    fixtures = await seedTestData();
    // Cross-org test precedent: test/integration/invoices/organization-
    // scope.test.ts's own "A Project inside org B" fixture — the shared
    // seed graph has no Project under org B at all, so a cross-org
    // Invoice fixture needs its own dedicated Project.
    projectB = await prisma.project.create({
      data: {
        name: "Test Project B",
        clientId: fixtures.clientB.id,
        organizationId: fixtures.orgB.id,
        ownerId: fixtures.orgBOwner.id,
        status: "IN_PROGRESS",
      },
    });
  });

  afterAll(async () => {
    await prisma.invoicePdfArchiveObject.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-` } } });
    await prisma.project.deleteMany({ where: { id: projectB.id } });
    await cleanupTestData(fixtures);
  });

  // --- Authorization / rate limiting ---------------------------------------

  it("an unauthenticated request preserves the existing app-wide redirect-to-login behavior, with no Invoice-domain or ledger query and no signer call", async () => {
    const invoiceSpy = vi.spyOn(prisma.invoice, "findFirst");
    const ledgerSpy = vi.spyOn(prisma.invoicePdfArchiveObject, "findFirst");
    try {
      let caught: unknown;
      try {
        await pdfRequest(randomUUID());
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RedirectSignal);
      expect(invoiceSpy).not.toHaveBeenCalled();
      expect(ledgerSpy).not.toHaveBeenCalled();
      expect(mockedSign).not.toHaveBeenCalled();
    } finally {
      invoiceSpy.mockRestore();
      ledgerSpy.mockRestore();
    }
  });

  it("a rate-limited request returns 429 with the generic message, before any Invoice-domain or ledger query, and never calls the signer", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    mockedCheckRateLimit.mockReturnValue({ limited: true, message: RATE_LIMIT_MESSAGE });

    const invoiceSpy = vi.spyOn(prisma.invoice, "findFirst");
    const ledgerSpy = vi.spyOn(prisma.invoicePdfArchiveObject, "findFirst");
    try {
      const response = await pdfRequest(randomUUID());
      expect(response.status).toBe(429);
      expect(await response.text()).toBe(RATE_LIMIT_MESSAGE);
      expect(invoiceSpy).not.toHaveBeenCalled();
      expect(ledgerSpy).not.toHaveBeenCalled();
      expect(mockedSign).not.toHaveBeenCalled();
    } finally {
      invoiceSpy.mockRestore();
      ledgerSpy.mockRestore();
    }
  });

  // --- Role coverage --------------------------------------------------------

  for (const role of ["owner", "admin", "member"] as const) {
    it(`${role.toUpperCase()} succeeds — 307 with the exact signed Location and Cache-Control`, async () => {
      actAs(fixtures[role], fixtures.orgA.id);
      const { invoice } = await seedArchivedInvoice(fixtures);

      const response = await pdfRequest(invoice.id);

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(DEFAULT_SIGNED_URL);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    });
  }

  // --- 404 collapse: nonexistent / cross-org / DRAFT / legacy / invariant --

  it("a nonexistent Invoice id returns the generic 404", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const response = await pdfRequest(randomUUID());
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(mockedSign).not.toHaveBeenCalled();
  });

  it("a cross-organization archived Invoice returns a byte-identical generic 404", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);

    const invoiceId = randomUUID();
    const archiveId = randomUUID();
    const path = buildInvoicePdfStoragePath({ organizationId: fixtures.orgB.id, invoiceId, documentVersion: 1, archiveId });
    const crossOrgInvoice = await prisma.invoice.create({
      data: {
        id: invoiceId,
        invoiceNumber: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}-crossorg`,
        status: "SENT",
        amount: "10.00",
        subtotal: "10.00",
        discountAmount: "0.00",
        taxAmount: "0.00",
        finalizedAt: FIXED_NOW,
        pdfGeneratedAt: FIXED_NOW,
        issuerSnapshot: VALID_ISSUER_SNAPSHOT,
        recipientSnapshot: VALID_RECIPIENT_SNAPSHOT,
        documentVersion: 1,
        pdfStoragePath: path,
        projectId: projectB.id,
        clientId: fixtures.clientB.id,
        organizationId: fixtures.orgB.id,
      },
    });

    const [nonexistentResponse, crossOrgResponse] = await Promise.all([pdfRequest(randomUUID()), pdfRequest(crossOrgInvoice.id)]);

    expect(crossOrgResponse.status).toBe(404);
    expect(await crossOrgResponse.text()).toBe(await nonexistentResponse.text());
    expect(nonexistentResponse.status).toBe(crossOrgResponse.status);
    expect(mockedSign).not.toHaveBeenCalled();
  });

  it("a DRAFT Invoice returns the generic 404", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const invoice = await seedDraftInvoice(fixtures);
    const response = await pdfRequest(invoice.id);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(mockedSign).not.toHaveBeenCalled();
  });

  it("a legacy_eligible Invoice returns the generic 404", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const invoice = await seedLegacyEligibleInvoice(fixtures);
    const response = await pdfRequest(invoice.id);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(mockedSign).not.toHaveBeenCalled();
  });

  for (const reason of ["draft_with_archive_fields", "incomplete_archive_fields", "snapshot_unparseable"] as const) {
    it(`an invariant_violation Invoice (${reason}) returns the generic 404`, async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const invoice = await seedInvariantViolationInvoice(fixtures, reason);
      const response = await pdfRequest(invoice.id);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
      expect(mockedSign).not.toHaveBeenCalled();
    });
  }

  // --- 502 collapse: ledger branch A (no matching row) ----------------------

  for (const ledgerMode of ["none", "wrongVersion", "wrongStatus", "wrongPath", "nullReferencedAt"] as const) {
    it(`archived Invoice with no matching REFERENCED ledger row (${ledgerMode}) returns the generic 502, never calling the signer`, async () => {
      actAs(fixtures.owner, fixtures.orgA.id);
      const { invoice } = await seedArchivedInvoice(fixtures, { ledger: ledgerMode });

      const response = await pdfRequest(invoice.id);

      expect(response.status).toBe(502);
      expect(await response.text()).toBe("Unable to generate a download link.");
      expect(mockedSign).not.toHaveBeenCalled();
    });
  }

  // --- 502 collapse: ledger branch B (returned row, identity mismatch) -----

  it("archived Invoice with a ledger row that satisfies every predicate but whose id does not reproduce the shared persisted path returns the generic 502, never calling the signer", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const { invoice } = await seedArchivedInvoice(fixtures, { ledger: "mismatchedIdentity" });

    // Direct test-side proof, with the exact same six predicates the
    // route itself uses, that this is genuinely NOT the "no matching
    // ledger" branch — the row really is returned.
    const directLedgerLookup = await prisma.invoicePdfArchiveObject.findFirst({
      where: {
        organizationId: fixtures.orgA.id,
        invoiceId: invoice.id,
        storagePath: invoice.pdfStoragePath!,
        documentVersion: invoice.documentVersion,
        status: "REFERENCED",
        referencedAt: { not: null },
      },
    });
    expect(directLedgerLookup).not.toBeNull();

    const response = await pdfRequest(invoice.id);

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Unable to generate a download link.");
    expect(mockedSign).not.toHaveBeenCalled();
  });

  // --- 502 collapse: signing helper failures --------------------------------

  it("createInvoicePdfSignedUrl() returning storage_not_configured produces the generic 502", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const { invoice } = await seedArchivedInvoice(fixtures);
    mockedSign.mockResolvedValue({ ok: false, reason: "storage_not_configured" });

    const response = await pdfRequest(invoice.id);

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Unable to generate a download link.");
    expect(mockedSign).toHaveBeenCalledTimes(1);
  });

  it("createInvoicePdfSignedUrl() returning signed_url_failed produces the generic 502", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const { invoice } = await seedArchivedInvoice(fixtures);
    mockedSign.mockResolvedValue({ ok: false, reason: "signed_url_failed" });

    const response = await pdfRequest(invoice.id);

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Unable to generate a download link.");
    expect(mockedSign).toHaveBeenCalledTimes(1);
  });

  // --- Success — exact call shape, response shape ---------------------------

  it("success: 307 body has no PDF bytes and no application/pdf Content-Type", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const { invoice } = await seedArchivedInvoice(fixtures);

    const response = await pdfRequest(invoice.id);

    expect(response.status).toBe(307);
    const body = await response.text();
    expect(body).toBe("");
    expect(response.headers.get("content-type")).not.toBe("application/pdf");
  });

  it("success: the signer is called exactly once, with the structured identity (organizationId/invoiceId/documentVersion/archiveId) and invoiceNumber — never a raw storage path", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const { invoice, archiveId } = await seedArchivedInvoice(fixtures, { documentVersion: 2 });

    const response = await pdfRequest(invoice.id);
    expect(response.status).toBe(307);

    expect(mockedSign).toHaveBeenCalledTimes(1);
    const [callArgs] = mockedSign.mock.calls[0];
    expect(callArgs).toEqual({
      identity: {
        organizationId: fixtures.orgA.id,
        invoiceId: invoice.id,
        documentVersion: 2,
        archiveId,
      },
      invoiceNumber: invoice.invoiceNumber,
    });
    // Structural proof that no raw path/storagePath field was ever passed.
    expect(Object.keys(callArgs)).toEqual(["identity", "invoiceNumber"]);
    expect(Object.keys((callArgs as { identity: object }).identity)).toEqual([
      "organizationId",
      "invoiceId",
      "documentVersion",
      "archiveId",
    ]);
  });

  // --- Zero-write invariant --------------------------------------------------

  describe("zero-write invariant — representative outcomes leave every scoped row count unchanged", () => {
    const scenarios: Array<{ name: string; build: () => Promise<string> }> = [
      { name: "success", build: async () => (await seedArchivedInvoice(fixtures)).invoice.id },
      { name: "DRAFT (404)", build: async () => (await seedDraftInvoice(fixtures)).id },
      { name: "no matching ledger (502)", build: async () => (await seedArchivedInvoice(fixtures, { ledger: "none" })).invoice.id },
      {
        name: "mismatched ledger identity (502)",
        build: async () => (await seedArchivedInvoice(fixtures, { ledger: "mismatchedIdentity" })).invoice.id,
      },
    ];

    for (const scenario of scenarios) {
      it(`${scenario.name} — no Invoice/InvoiceLineItem/InvoicePdfArchiveObject/Activity/Notification row is created, modified, or removed`, async () => {
        actAs(fixtures.owner, fixtures.orgA.id);
        const invoiceId = await scenario.build();

        // Row-count evidence (kept as additional, weaker corroboration —
        // catches an org-wide create/delete but not an in-place mutation
        // of an already-existing row).
        const countsBefore = await countScopedRows(fixtures.orgA.id);
        // Exact-state evidence — the actual claim: every field of the
        // target Invoice, every InvoiceLineItem, every InvoicePdfArchiveObject
        // row, and every Activity/Notification row scoped to this exact
        // Invoice is byte-for-byte identical before and after the request,
        // not merely equal in count.
        const stateBefore = await captureInvoiceState(invoiceId, fixtures.orgA.id);

        await pdfRequest(invoiceId);

        const countsAfter = await countScopedRows(fixtures.orgA.id);
        const stateAfter = await captureInvoiceState(invoiceId, fixtures.orgA.id);

        expect(countsAfter).toEqual(countsBefore);
        expect(stateAfter).toEqual(stateBefore);
      });
    }
  });
});
