import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/portal/invoices/[id]/pdf/route";
import { buildInvoicePdfStoragePath, createInvoicePdfSignedUrl } from "@/lib/invoices/pdf/storage";
import { checkRateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { setMockAuthUser, resetAuthMock } from "../../support/auth-mock";
import { RedirectSignal } from "../../support/navigation-mock";

/**
 * Invoice System Official Slice 3 — Portal Invoice PDF access. Calls the
 * real, unmodified GET export directly with real seeded Prisma data, the
 * real getCurrentPortalUser() resolution, and the real
 * classifyInvoiceArchival()/buildInvoicePdfStoragePath() logic. Only the
 * two unavoidable external/control boundaries are mocked, file-locally
 * (this file's own vi.mock() calls take precedence over
 * test/integration/setup-mocks.ts's own @/lib/rate-limit registration for
 * this file only — the same standard per-file Vitest module-mock
 * override the staff test/integration/invoices/pdf-download.test.ts
 * already established):
 *  - createInvoicePdfSignedUrl() (@/lib/invoices/pdf/storage) — no real
 *    Storage is ever contacted; success/failure/call-ordering are fully
 *    controllable per test. buildInvoicePdfStoragePath() and every other
 *    export of this module stay real (spread from importOriginal).
 *  - checkRateLimit() (@/lib/rate-limit) — the limited branch is
 *    controllable per test; every other export stays real.
 *
 * getCurrentPortalUser(), Prisma, classifyInvoiceArchival(), and
 * buildInvoicePdfStoragePath() are never mocked.
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
  return GET(new Request(`http://localhost/api/portal/invoices/${id}/pdf`), {
    params: Promise.resolve({ id }),
  });
}

const INVOICE_NUMBER_PREFIX = "PORTAL-INV-PDF-DL";
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
  target: { clientId: string; projectId: string; organizationId: string },
  opts: { documentVersion?: number; ledger?: LedgerMode; invoiceNumberSuffix?: string } = {},
) {
  const documentVersion = opts.documentVersion ?? 1;
  const ledgerMode = opts.ledger ?? "matching";
  const invoiceId = randomUUID();
  const archiveId = randomUUID();
  const path = buildInvoicePdfStoragePath({
    organizationId: target.organizationId,
    invoiceId,
    documentVersion,
    archiveId,
  });

  const invoice = await prisma.invoice.create({
    data: {
      id: invoiceId,
      invoiceNumber: `${INVOICE_NUMBER_PREFIX}-${opts.invoiceNumberSuffix ?? invoiceId.slice(0, 8)}`,
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
      projectId: target.projectId,
      clientId: target.clientId,
      organizationId: target.organizationId,
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
        ? buildInvoicePdfStoragePath({ organizationId: target.organizationId, invoiceId, documentVersion, archiveId: randomUUID() })
        : path;

    await prisma.invoicePdfArchiveObject.create({
      data: {
        id: ledgerArchiveId,
        organizationId: target.organizationId,
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

async function seedDraftInvoice(target: { clientId: string; projectId: string; organizationId: string }) {
  return prisma.invoice.create({
    data: {
      invoiceNumber: `${INVOICE_NUMBER_PREFIX}-DRAFT-${randomUUID().slice(0, 8)}`,
      status: "DRAFT",
      amount: "10.00",
      subtotal: "10.00",
      discountAmount: "0.00",
      taxAmount: "0.00",
      projectId: target.projectId,
      clientId: target.clientId,
      organizationId: target.organizationId,
    },
  });
}

async function seedLegacyEligibleInvoice(target: { clientId: string; projectId: string; organizationId: string }) {
  return prisma.invoice.create({
    data: {
      invoiceNumber: `${INVOICE_NUMBER_PREFIX}-LEGACY-${randomUUID().slice(0, 8)}`,
      status: "SENT",
      amount: "10.00",
      subtotal: "10.00",
      discountAmount: "0.00",
      taxAmount: "0.00",
      // finalizedAt/pdfStoragePath/pdfGeneratedAt/issuerSnapshot/
      // recipientSnapshot are all left null by construction — a real
      // pre-Slice-3 historical row.
      projectId: target.projectId,
      clientId: target.clientId,
      organizationId: target.organizationId,
    },
  });
}

async function seedInvariantViolationInvoice(
  target: { clientId: string; projectId: string; organizationId: string },
  reason: "draft_with_archive_fields" | "incomplete_archive_fields" | "snapshot_unparseable",
) {
  const base = {
    invoiceNumber: `${INVOICE_NUMBER_PREFIX}-INVARIANT-${reason}-${randomUUID().slice(0, 8)}`,
    amount: "10.00",
    subtotal: "10.00",
    discountAmount: "0.00",
    taxAmount: "0.00",
    projectId: target.projectId,
    clientId: target.clientId,
    organizationId: target.organizationId,
  };

  if (reason === "draft_with_archive_fields") {
    return prisma.invoice.create({ data: { ...base, status: "DRAFT", finalizedAt: FIXED_NOW } });
  }

  if (reason === "incomplete_archive_fields") {
    return prisma.invoice.create({ data: { ...base, status: "SENT", finalizedAt: FIXED_NOW } });
  }

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

/**
 * Normalizes exactly the two field shapes that would otherwise make a
 * structurally-identical row compare unequal across two separate reads:
 * a Prisma.Decimal (compared by its exact string representation) and a
 * Date (compared by its exact ISO string). Every other field is left
 * completely untouched.
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
 * row the route could conceivably touch — not merely a count.
 */
async function captureInvoiceState(invoiceId: string, organizationId: string) {
  const [invoice, lineItems, ledgerRows, activities, notifications] = await Promise.all([
    prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } }),
    prisma.invoiceLineItem.findMany({ where: { invoiceId }, orderBy: [{ position: "asc" }, { id: "asc" }] }),
    prisma.invoicePdfArchiveObject.findMany({ where: { invoiceId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    prisma.activity.findMany({
      where: { organizationId, entityType: "INVOICE", entityId: invoiceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
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

/**
 * Exact, deterministically-ordered PortalDownloadRequest state for one
 * organization — the required negative proof that this route never
 * writes analytics. Deliberately not just a count: comparing the full
 * row set (including a deliberately pre-existing sentinel row, seeded
 * once in beforeAll and never touched by any test in this file) proves
 * both "no row was added" and "no existing row was mutated," and never
 * asserts the organization's analytics history is empty — only that it
 * is unchanged by this route.
 */
async function capturePortalDownloadRequestState(organizationId: string) {
  const rows = await prisma.portalDownloadRequest.findMany({
    where: { organizationId },
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
  });
  return rows.map((row) => normalizeRow(row as unknown as Record<string, unknown>));
}

describe("GET /api/portal/invoices/[id]/pdf — Invoice System Official Slice 3, Portal Invoice PDF access", () => {
  let fixtures: TestFixtures;
  // A second Client/Project inside org A — the shared seed graph has only
  // one Client per organization, so a same-organization/different-Client
  // isolation proof needs its own dedicated pair, mirroring
  // test/integration/invoices/organization-scope.test.ts's own
  // "clientA2"/"projectA2" precedent exactly.
  let clientA2: { id: string };
  let projectA2: { id: string };
  // A Project inside org B, mirroring the staff pdf-download test's own
  // "projectB" precedent — the shared seed graph has no Project under
  // org B at all.
  let projectB: { id: string };
  let sentinelDownloadRequest: { id: string; organizationId: string };

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

    // A pre-existing analytics row, created once and never touched again —
    // proves the route neither inserts a new row nor mutates this one,
    // never merely that the organization's analytics table is empty.
    sentinelDownloadRequest = await prisma.portalDownloadRequest.create({
      data: { organizationId: fixtures.orgA.id, requestedAt: FIXED_NOW },
    });
  });

  afterAll(async () => {
    await prisma.invoicePdfArchiveObject.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-` } } });
    await prisma.project.deleteMany({ where: { id: { in: [projectA2.id, projectB.id] } } });
    await prisma.client.deleteMany({ where: { id: clientA2.id } });
    // The sentinel row is cascade-deleted when cleanupTestData() below
    // removes its organization — no separate delete needed.
    await cleanupTestData(fixtures);
  });

  function targetA() {
    return { clientId: fixtures.clientA.id, projectId: fixtures.project.id, organizationId: fixtures.orgA.id };
  }

  function actAsPortalUser() {
    setMockAuthUser({ id: fixtures.portalUser.id, email: fixtures.portalUser.email });
  }

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

  it("a staff-only identity (no PortalUser row) preserves the same redirect-to-login behavior, with no Invoice-domain or ledger query and no signer call", async () => {
    setMockAuthUser({ id: fixtures.owner.id, email: fixtures.owner.email });

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
    actAsPortalUser();
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

  it("the correct PortalUser succeeds — 307 with the exact signed Location and Cache-Control", async () => {
    actAsPortalUser();
    const { invoice } = await seedArchivedInvoice(targetA());

    const response = await pdfRequest(invoice.id);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(DEFAULT_SIGNED_URL);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  // --- 404 collapse: nonexistent / cross-org / same-org-different-client / DRAFT / legacy / invariant --

  it("a nonexistent Invoice id returns the generic 404", async () => {
    actAsPortalUser();
    const response = await pdfRequest(randomUUID());
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(mockedSign).not.toHaveBeenCalled();
  });

  it("a cross-organization archived Invoice and a nonexistent id return a byte-identical generic 404", async () => {
    actAsPortalUser();
    const { invoice: crossOrgInvoice } = await seedArchivedInvoice(
      { clientId: fixtures.clientB.id, projectId: projectB.id, organizationId: fixtures.orgB.id },
      { invoiceNumberSuffix: "crossorg" },
    );

    const [nonexistentResponse, crossOrgResponse] = await Promise.all([pdfRequest(randomUUID()), pdfRequest(crossOrgInvoice.id)]);

    expect(crossOrgResponse.status).toBe(404);
    expect(await crossOrgResponse.text()).toBe(await nonexistentResponse.text());
    expect(nonexistentResponse.status).toBe(crossOrgResponse.status);
    expect(mockedSign).not.toHaveBeenCalled();
  });

  it("a same-organization, different-Client archived Invoice returns a byte-identical generic 404 — the strongest Portal isolation proof", async () => {
    actAsPortalUser();
    const { invoice: sameOrgOtherClientInvoice } = await seedArchivedInvoice(
      { clientId: clientA2.id, projectId: projectA2.id, organizationId: fixtures.orgA.id },
      { invoiceNumberSuffix: "sameorg-otherclient" },
    );

    const [nonexistentResponse, otherClientResponse] = await Promise.all([
      pdfRequest(randomUUID()),
      pdfRequest(sameOrgOtherClientInvoice.id),
    ]);

    expect(otherClientResponse.status).toBe(404);
    expect(await otherClientResponse.text()).toBe(await nonexistentResponse.text());
    expect(nonexistentResponse.status).toBe(otherClientResponse.status);
    expect(mockedSign).not.toHaveBeenCalled();
  });

  it("a DRAFT Invoice returns the generic 404", async () => {
    actAsPortalUser();
    const invoice = await seedDraftInvoice(targetA());
    const response = await pdfRequest(invoice.id);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(mockedSign).not.toHaveBeenCalled();
  });

  it("a legacy_eligible Invoice returns the generic 404", async () => {
    actAsPortalUser();
    const invoice = await seedLegacyEligibleInvoice(targetA());
    const response = await pdfRequest(invoice.id);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(mockedSign).not.toHaveBeenCalled();
  });

  for (const reason of ["draft_with_archive_fields", "incomplete_archive_fields", "snapshot_unparseable"] as const) {
    it(`an invariant_violation Invoice (${reason}) returns the generic 404`, async () => {
      actAsPortalUser();
      const invoice = await seedInvariantViolationInvoice(targetA(), reason);
      const response = await pdfRequest(invoice.id);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
      expect(mockedSign).not.toHaveBeenCalled();
    });
  }

  // --- 502 collapse: ledger branch A (no matching row) ----------------------

  for (const ledgerMode of ["none", "wrongVersion", "wrongStatus", "wrongPath", "nullReferencedAt"] as const) {
    it(`archived Invoice with no matching REFERENCED ledger row (${ledgerMode}) returns the generic 502, never calling the signer`, async () => {
      actAsPortalUser();
      const { invoice } = await seedArchivedInvoice(targetA(), { ledger: ledgerMode });

      const response = await pdfRequest(invoice.id);

      expect(response.status).toBe(502);
      expect(await response.text()).toBe("Unable to generate a download link.");
      expect(mockedSign).not.toHaveBeenCalled();
    });
  }

  // --- 502 collapse: ledger branch B (returned row, identity mismatch) -----

  it("archived Invoice with a ledger row that satisfies every predicate but whose id does not reproduce the shared persisted path returns the generic 502, never calling the signer", async () => {
    actAsPortalUser();
    const { invoice } = await seedArchivedInvoice(targetA(), { ledger: "mismatchedIdentity" });

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
    actAsPortalUser();
    const { invoice } = await seedArchivedInvoice(targetA());
    mockedSign.mockResolvedValue({ ok: false, reason: "storage_not_configured" });

    const response = await pdfRequest(invoice.id);

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Unable to generate a download link.");
    expect(mockedSign).toHaveBeenCalledTimes(1);
  });

  it("createInvoicePdfSignedUrl() returning signed_url_failed produces the generic 502", async () => {
    actAsPortalUser();
    const { invoice } = await seedArchivedInvoice(targetA());
    mockedSign.mockResolvedValue({ ok: false, reason: "signed_url_failed" });

    const response = await pdfRequest(invoice.id);

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Unable to generate a download link.");
    expect(mockedSign).toHaveBeenCalledTimes(1);
  });

  // --- Success — exact call shape, response shape ---------------------------

  it("success: 307 body has no PDF bytes and no application/pdf Content-Type", async () => {
    actAsPortalUser();
    const { invoice } = await seedArchivedInvoice(targetA());

    const response = await pdfRequest(invoice.id);

    expect(response.status).toBe(307);
    const body = await response.text();
    expect(body).toBe("");
    expect(response.headers.get("content-type")).not.toBe("application/pdf");
  });

  it("success: the signer is called exactly once, with the structured identity (organizationId/invoiceId/documentVersion/archiveId) and invoiceNumber — never a raw storage path", async () => {
    actAsPortalUser();
    const { invoice, archiveId } = await seedArchivedInvoice(targetA(), { documentVersion: 2 });

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

  it("success: no PortalDownloadRequest row is created, and the pre-existing sentinel row is untouched", async () => {
    actAsPortalUser();
    const { invoice } = await seedArchivedInvoice(targetA());

    const before = await capturePortalDownloadRequestState(fixtures.orgA.id);
    expect(before).toEqual([normalizeRow(sentinelDownloadRequest as unknown as Record<string, unknown>)]);

    const response = await pdfRequest(invoice.id);
    expect(response.status).toBe(307);

    const after = await capturePortalDownloadRequestState(fixtures.orgA.id);
    expect(after).toEqual(before);
  });

  // --- Zero-write invariant --------------------------------------------------

  describe("zero-write invariant — representative outcomes leave every scoped row, and PortalDownloadRequest, unchanged", () => {
    const scenarios: Array<{ name: string; build: () => Promise<string> }> = [
      { name: "success", build: async () => (await seedArchivedInvoice(targetA())).invoice.id },
      { name: "DRAFT (404)", build: async () => (await seedDraftInvoice(targetA())).id },
      { name: "no matching ledger (502)", build: async () => (await seedArchivedInvoice(targetA(), { ledger: "none" })).invoice.id },
      {
        name: "mismatched ledger identity (502)",
        build: async () => (await seedArchivedInvoice(targetA(), { ledger: "mismatchedIdentity" })).invoice.id,
      },
    ];

    for (const scenario of scenarios) {
      it(`${scenario.name} — no Invoice/InvoiceLineItem/InvoicePdfArchiveObject/Activity/Notification/PortalDownloadRequest row is created, modified, or removed`, async () => {
        actAsPortalUser();
        const invoiceId = await scenario.build();

        const stateBefore = await captureInvoiceState(invoiceId, fixtures.orgA.id);
        const analyticsBefore = await capturePortalDownloadRequestState(fixtures.orgA.id);

        await pdfRequest(invoiceId);

        const stateAfter = await captureInvoiceState(invoiceId, fixtures.orgA.id);
        const analyticsAfter = await capturePortalDownloadRequestState(fixtures.orgA.id);

        expect(stateAfter).toEqual(stateBefore);
        expect(analyticsAfter).toEqual(analyticsBefore);
      });
    }
  });
});
