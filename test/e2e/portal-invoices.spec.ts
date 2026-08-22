import { test, expect, type BrowserContext } from "@playwright/test";
import { seedE2EFixtures, cleanupTestData, dbQuery, type TestFixtures } from "./fixtures";
import { injectTestSession } from "../support/e2e-session";

/**
 * Invoice System Official Slice 3 — Portal Invoice PDF access. Same
 * session-injection pattern as test/e2e/invoices.spec.ts's own
 * actAsRole, duplicated here (a plain local helper, not exported from
 * that file) since Issue itself is staff OWNER-only and must be driven
 * through the real staff UI before any Portal-side assertion can run.
 */
async function actAsRole(
  context: BrowserContext,
  baseURL: string,
  user: { id: string; email: string },
  organizationId: string,
): Promise<void> {
  await context.clearCookies();
  await injectTestSession(context, user, baseURL);
  await context.addCookies([
    {
      name: "active_organization_id",
      value: organizationId,
      domain: new URL(baseURL).hostname,
      path: "/",
      httpOnly: true,
      secure: new URL(baseURL).protocol === "https:",
      sameSite: "Lax",
    },
  ]);
}

/** Switches the same BrowserContext to a Client Portal identity — clears any lingering staff cookie first (matching actAsRole's own clear-then-set discipline), even though Portal identity resolution never reads the staff active_organization_id cookie. */
async function actAsPortalUser(
  context: BrowserContext,
  baseURL: string,
  portalUser: { id: string; email: string },
): Promise<void> {
  await context.clearCookies();
  await injectTestSession(context, portalUser, baseURL);
}

/**
 * Exact, deterministically-ordered state for one target Invoice and every
 * row the Portal download route could conceivably touch, plus the
 * organization-scoped PortalDownloadRequest set — mirroring
 * test/e2e/invoices.spec.ts's own captureInvoiceSnapshot() exactly, with
 * PortalDownloadRequest added as the required negative analytics proof.
 */
async function captureInvoiceSnapshot(invoiceId: string, organizationId: string) {
  const [invoiceRow, lineItems, ledgerRows, activities, notifications, portalDownloadRequests] = await Promise.all([
    dbQuery<Record<string, unknown>>("invoice", "findUniqueOrThrow", { where: { id: invoiceId } }),
    dbQuery<Record<string, unknown>[]>("invoiceLineItem", "findMany", {
      where: { invoiceId },
      orderBy: [{ position: "asc" }, { id: "asc" }],
    }),
    dbQuery<Record<string, unknown>[]>("invoicePdfArchiveObject", "findMany", {
      where: { invoiceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    dbQuery<Record<string, unknown>[]>("activity", "findMany", {
      where: { organizationId, entityType: "INVOICE", entityId: invoiceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    dbQuery<Record<string, unknown>[]>("notification", "findMany", {
      where: { organizationId, entityType: "INVOICE", entityId: invoiceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    dbQuery<Record<string, unknown>[]>("portalDownloadRequest", "findMany", {
      where: { organizationId },
      orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    }),
  ]);
  return { invoice: invoiceRow, lineItems, ledgerRows, activities, notifications, portalDownloadRequests };
}

async function issueThroughRealUi(
  page: import("@playwright/test").Page,
  invoiceId: string,
): Promise<void> {
  await page.goto(`/invoices/${invoiceId}/edit`);
  await page.getByRole("button", { name: "Issue invoice" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Issue invoice" }).click();
  await expect(page.getByText("Invoice issued")).toBeVisible();
}

let fixtures: TestFixtures;

test.beforeAll(async () => {
  fixtures = await seedE2EFixtures();
});

test.afterAll(async () => {
  await cleanupTestData(fixtures);
});

test.describe("Portal Invoice PDF access", () => {
  test("Download PDF appears only for the correct PortalUser's own archived Invoice, and the real Portal route serves the archived object through the TEST_MODE redirect chain", async ({
    context,
    baseURL,
    page,
  }) => {
    // 1-4. Real Issue, driven entirely through the staff UI — the only
    // way to produce actual TEST_MODE Storage bytes (a direct dbQuery
    // Invoice+ledger fixture would leave the server process's in-memory
    // Storage map empty, and the final e2e-test-storage request would
    // 404).
    await actAsRole(context, baseURL!, fixtures.owner, fixtures.orgA.id);

    const invoice = await dbQuery<{ id: string }>("invoice", "create", {
      data: {
        invoiceNumber: `E2E-PORTAL-PDF-${fixtures.runId}`,
        status: "DRAFT",
        amount: "250.00",
        subtotal: "250.00",
        discountAmount: "0.00",
        taxAmount: "0.00",
        projectId: fixtures.project.id,
        clientId: fixtures.clientA.id,
        organizationId: fixtures.orgA.id,
      },
    });

    await issueThroughRealUi(page, invoice.id);

    // 5. Confirm exactly one REFERENCED ledger row exists before ever
    // touching the Portal side.
    const ledgerAfterIssue = await dbQuery<Record<string, unknown>[]>("invoicePdfArchiveObject", "findMany", {
      where: { invoiceId: invoice.id },
    });
    expect(ledgerAfterIssue).toHaveLength(1);
    expect(ledgerAfterIssue[0].status).toBe("REFERENCED");

    // 6-7. Switch the same BrowserContext to the PortalUser belonging to
    // this Invoice's own Client.
    await actAsPortalUser(context, baseURL!, { id: fixtures.portalUser.id, email: fixtures.portalUser.email });
    await page.goto(`/portal/invoices/${invoice.id}`);

    // 8-10. Exactly one link, exact href.
    const downloadLink = page.getByRole("link", { name: "Download PDF" });
    await expect(downloadLink).toHaveCount(1);
    const downloadHref = await downloadLink.getAttribute("href");
    expect(downloadHref).toBe(`/api/portal/invoices/${invoice.id}/pdf`);

    // 11. Exact pre-download state, including PortalDownloadRequest.
    const before = await captureInvoiceSnapshot(invoice.id, fixtures.orgA.id);

    // 12. Redirect-disabled request.
    const redirectResponse = await page.request.get(downloadHref!, { maxRedirects: 0 });
    expect(redirectResponse.status()).toBe(307);
    expect(redirectResponse.headers()["cache-control"]).toBe("private, no-store");
    expect(redirectResponse.headers()["location"]).toContain("/api/e2e-test-storage/attachments/");

    // 13. Redirect-following request — the actual TEST_MODE PDF bytes
    // produced by the real staff Issue render above.
    const fileResponse = await page.request.get(downloadHref!);
    expect(fileResponse.status()).toBe(200);
    const bytes = await fileResponse.body();
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("%PDF");

    // 14-15. Exact post-download state, including PortalDownloadRequest —
    // proves the download changed nothing, and specifically that it
    // created no analytics row.
    const after = await captureInvoiceSnapshot(invoice.id, fixtures.orgA.id);
    expect(after).toEqual(before);

    await dbQuery("invoicePdfArchiveObject", "deleteMany", { where: { invoiceId: invoice.id } });
    await dbQuery("invoice", "deleteMany", { where: { id: invoice.id } });
  });

  test("a same-organization, different-Client archived Invoice is unreachable through the Portal route for the wrong PortalUser — the strongest Portal isolation proof", async ({
    context,
    baseURL,
    page,
  }) => {
    // A second Client/Project inside org A, distinct from fixtures.clientA
    // (which fixtures.portalUser belongs to) — the same organization, a
    // different Client, so this proves Client-level isolation
    // specifically, not merely organization-level isolation.
    await actAsRole(context, baseURL!, fixtures.owner, fixtures.orgA.id);

    const clientA2 = await dbQuery<{ id: string }>("client", "create", {
      data: { name: `Portal E2E Second Client ${fixtures.runId}`, organizationId: fixtures.orgA.id, userId: fixtures.owner.id },
    });
    const projectA2 = await dbQuery<{ id: string }>("project", "create", {
      data: {
        name: `Portal E2E Second Project ${fixtures.runId}`,
        clientId: clientA2.id,
        organizationId: fixtures.orgA.id,
        ownerId: fixtures.owner.id,
        status: "IN_PROGRESS",
      },
    });

    try {
      const invoice = await dbQuery<{ id: string }>("invoice", "create", {
        data: {
          invoiceNumber: `E2E-PORTAL-PDF-OTHERCLIENT-${fixtures.runId}`,
          status: "DRAFT",
          amount: "150.00",
          subtotal: "150.00",
          discountAmount: "0.00",
          taxAmount: "0.00",
          projectId: projectA2.id,
          clientId: clientA2.id,
          organizationId: fixtures.orgA.id,
        },
      });

      // Issue for real, through the same orgA OWNER — its PDF genuinely
      // exists in TEST_MODE Storage, exactly like the positive case.
      await issueThroughRealUi(page, invoice.id);

      const before = await captureInvoiceSnapshot(invoice.id, fixtures.orgA.id);

      // Switch to fixtures.portalUser — belongs to clientA, not clientA2.
      await actAsPortalUser(context, baseURL!, { id: fixtures.portalUser.id, email: fixtures.portalUser.email });

      const response = await page.request.get(`/api/portal/invoices/${invoice.id}/pdf`, { maxRedirects: 0 });
      expect(response.status()).toBe(404);
      expect(await response.text()).toBe("Not found");
      // No redirect to Storage of any kind.
      expect(response.headers()["location"]).toBeUndefined();

      const after = await captureInvoiceSnapshot(invoice.id, fixtures.orgA.id);
      expect(after).toEqual(before);

      await dbQuery("invoicePdfArchiveObject", "deleteMany", { where: { invoiceId: invoice.id } });
      await dbQuery("invoice", "deleteMany", { where: { id: invoice.id } });
    } finally {
      await dbQuery("project", "deleteMany", { where: { id: projectA2.id } });
      await dbQuery("client", "deleteMany", { where: { id: clientA2.id } });
    }
  });

  test("no Download PDF link is rendered for a DRAFT, legacy_eligible, or invariant_violation Invoice belonging to the correct Client", async ({
    context,
    baseURL,
    page,
  }) => {
    await actAsPortalUser(context, baseURL!, { id: fixtures.portalUser.id, email: fixtures.portalUser.email });

    const draftInvoice = await dbQuery<{ id: string }>("invoice", "create", {
      data: {
        invoiceNumber: `E2E-PORTAL-PDF-DRAFT-${fixtures.runId}`,
        status: "DRAFT",
        amount: "50.00",
        subtotal: "50.00",
        discountAmount: "0.00",
        taxAmount: "0.00",
        projectId: fixtures.project.id,
        clientId: fixtures.clientA.id,
        organizationId: fixtures.orgA.id,
      },
    });
    const legacyInvoice = await dbQuery<{ id: string }>("invoice", "create", {
      data: {
        invoiceNumber: `E2E-PORTAL-PDF-LEGACY-${fixtures.runId}`,
        status: "SENT",
        amount: "50.00",
        subtotal: "50.00",
        discountAmount: "0.00",
        taxAmount: "0.00",
        // finalizedAt/pdfStoragePath/pdfGeneratedAt/snapshots all left
        // null — a real pre-Slice-3 historical row (legacy_eligible).
        projectId: fixtures.project.id,
        clientId: fixtures.clientA.id,
        organizationId: fixtures.orgA.id,
      },
    });
    const invariantInvoice = await dbQuery<{ id: string }>("invoice", "create", {
      data: {
        invoiceNumber: `E2E-PORTAL-PDF-INVARIANT-${fixtures.runId}`,
        status: "SENT",
        finalizedAt: new Date().toISOString(),
        // pdfStoragePath/pdfGeneratedAt/snapshots left null — non-DRAFT
        // with a strict subset of archive fields populated:
        // invariant_violation("incomplete_archive_fields").
        amount: "50.00",
        subtotal: "50.00",
        discountAmount: "0.00",
        taxAmount: "0.00",
        projectId: fixtures.project.id,
        clientId: fixtures.clientA.id,
        organizationId: fixtures.orgA.id,
      },
    });

    try {
      for (const invoice of [draftInvoice, legacyInvoice, invariantInvoice]) {
        await page.goto(`/portal/invoices/${invoice.id}`);
        await expect(page.getByRole("link", { name: "Download PDF" })).toHaveCount(0);
      }
    } finally {
      await dbQuery("invoice", "deleteMany", {
        where: { id: { in: [draftInvoice.id, legacyInvoice.id, invariantInvoice.id] } },
      });
    }
  });
});

test.describe("Portal DRAFT-visibility correction — Invoice System Official Slice 5", () => {
  test("a DRAFT invoice is absent from the Portal 'all' and 'open' tabs, direct navigation to its detail page 404s, and an eligible non-DRAFT invoice remains visible and opens normally", async ({
    context,
    baseURL,
    page,
  }) => {
    const draftInvoice = await dbQuery<{ id: string; invoiceNumber: string }>("invoice", "create", {
      data: {
        invoiceNumber: `E2E-PORTAL-DRAFT-VIS-${fixtures.runId}`,
        status: "DRAFT",
        amount: "80.00",
        projectId: fixtures.project.id,
        clientId: fixtures.clientA.id,
        organizationId: fixtures.orgA.id,
      },
    });
    const visibleInvoice = await dbQuery<{ id: string; invoiceNumber: string }>("invoice", "create", {
      data: {
        invoiceNumber: `E2E-PORTAL-VISIBLE-VIS-${fixtures.runId}`,
        status: "SENT",
        amount: "90.00",
        projectId: fixtures.project.id,
        clientId: fixtures.clientA.id,
        organizationId: fixtures.orgA.id,
      },
    });

    try {
      await actAsPortalUser(context, baseURL!, { id: fixtures.portalUser.id, email: fixtures.portalUser.email });

      // "all" tab — DRAFT absent, the eligible invoice present.
      await page.goto("/portal/invoices");
      await expect(page.getByRole("row", { name: new RegExp(draftInvoice.invoiceNumber) })).toHaveCount(0);
      await expect(page.getByRole("row", { name: new RegExp(visibleInvoice.invoiceNumber) })).toBeVisible();

      // "open" tab — same again.
      await page.goto("/portal/invoices?status=open");
      await expect(page.getByRole("row", { name: new RegExp(draftInvoice.invoiceNumber) })).toHaveCount(0);
      await expect(page.getByRole("row", { name: new RegExp(visibleInvoice.invoiceNumber) })).toBeVisible();

      // Direct navigation to the DRAFT detail URL — a genuine not-found
      // outcome, not merely an absent list row. (dashboard)/invoices'
      // own loading.tsx precedent (see comments.spec.ts's identical note)
      // means the shell streams with 200 before notFound() fires deeper —
      // the rendered content is the correct thing to assert on here, not
      // the HTTP status, which cannot change after the stream starts.
      // Never leaks the invoice's own number/id/internal data on the
      // resulting page.
      await page.goto(`/portal/invoices/${draftInvoice.id}`);
      await expect(page.getByText("Page not found")).toBeVisible();
      await expect(page.getByText(draftInvoice.invoiceNumber)).toHaveCount(0);
      await expect(page.getByText(draftInvoice.id)).toHaveCount(0);

      // The eligible non-DRAFT invoice still opens normally.
      await page.goto(`/portal/invoices/${visibleInvoice.id}`);
      await expect(page.getByRole("heading", { name: visibleInvoice.invoiceNumber })).toBeVisible();
    } finally {
      await dbQuery("invoice", "deleteMany", { where: { id: { in: [draftInvoice.id, visibleInvoice.id] } } });
    }
  });
});
