import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { seedE2EFixtures, cleanupTestData, dbQuery, type TestFixtures } from "./fixtures";
import { injectTestSession } from "../support/e2e-session";

/**
 * Portal Analytics persistence foundation (docs/analytics-architecture.md
 * §12, Slice 1). Real, TEST_MODE-served signed-URL redirects, real
 * PortalDownloadRequest rows, over the actual portal download route — no
 * new UI to exercise yet (Slice 2), only the write path this route now
 * triggers.
 */
let fixtures: TestFixtures;

test.beforeAll(async () => {
  fixtures = await seedE2EFixtures();
});

test.afterAll(async () => {
  await cleanupTestData(fixtures);
});

test.afterEach(async () => {
  await dbQuery("portalDownloadRequest", "deleteMany", {
    where: { organizationId: { in: [fixtures.clientA.organizationId] } },
  });
});

test("an authorized portal attachment request receives the expected redirect and creates exactly one PortalDownloadRequest row", async ({
  context,
  page,
  baseURL,
}) => {
  await injectTestSession(context, { id: fixtures.portalUser.id, email: fixtures.portalUser.email }, baseURL!);

  const before = new Date();
  const response = await page.request.get(`/api/portal/attachments/${fixtures.attachment.id}/download`, {
    maxRedirects: 0,
  });
  const after = new Date();

  expect(response.status()).toBe(307);
  expect(response.headers()["location"]).toContain("/api/e2e-test-storage/attachments/");

  const rows = await dbQuery<{ organizationId: string; requestedAt: string }[]>("portalDownloadRequest", "findMany", {
    where: { organizationId: fixtures.clientA.organizationId },
  });
  expect(rows).toHaveLength(1);
  expect(rows[0].organizationId).toBe(fixtures.clientA.organizationId);
  const requestedAt = new Date(rows[0].requestedAt).getTime();
  expect(requestedAt).toBeGreaterThanOrEqual(before.getTime());
  expect(requestedAt).toBeLessThanOrEqual(after.getTime());
});

test("a second legitimate repeat request produces a second row", async ({ context, page, baseURL }) => {
  await injectTestSession(context, { id: fixtures.portalUser.id, email: fixtures.portalUser.email }, baseURL!);

  await page.request.get(`/api/portal/attachments/${fixtures.attachment.id}/download`, { maxRedirects: 0 });
  await page.request.get(`/api/portal/attachments/${fixtures.attachment.id}/download`, { maxRedirects: 0 });

  const count = await dbQuery<number>("portalDownloadRequest", "count", {
    where: { organizationId: fixtures.clientA.organizationId },
  });
  expect(count).toBe(2);
});

test("a cross-client request is rejected exactly as before, and creates no row", async ({ context, page, baseURL }) => {
  // A Client B attachment — Client B belongs to a different organization
  // than the portal identity used here, so this exercises both the
  // cross-client and cross-organization rejection paths at once.
  const otherOrgAttachmentId = randomUUID();
  await dbQuery("attachment", "create", {
    data: {
      id: otherOrgAttachmentId,
      organizationId: fixtures.clientB.organizationId,
      entityType: "CLIENT",
      entityId: fixtures.clientB.id,
      storageBucket: "attachments",
      storagePath: `organizations/${fixtures.clientB.organizationId}/CLIENT/${fixtures.clientB.id}/${otherOrgAttachmentId}/other.pdf`,
      originalName: "other.pdf",
      mimeType: "application/pdf",
      sizeBytes: 512,
    },
  });

  try {
    await injectTestSession(context, { id: fixtures.portalUser.id, email: fixtures.portalUser.email }, baseURL!);

    const response = await page.request.get(`/api/portal/attachments/${otherOrgAttachmentId}/download`, {
      maxRedirects: 0,
    });

    expect(response.status()).toBe(404);

    const rows = await dbQuery<unknown[]>("portalDownloadRequest", "findMany", {
      where: { organizationId: fixtures.clientB.organizationId },
    });
    expect(rows).toHaveLength(0);
  } finally {
    await dbQuery("attachment", "deleteMany", { where: { id: otherOrgAttachmentId } });
  }
});

test("an unauthenticated request never reaches the write path", async ({ page }) => {
  const response = await page.request.get(`/api/portal/attachments/${fixtures.attachment.id}/download`, {
    maxRedirects: 0,
  });

  // getCurrentPortalUser() redirects to /portal/login for no session.
  expect(response.status()).toBe(307);
  expect(response.headers()["location"]).toContain("/portal/login");

  const rows = await dbQuery<unknown[]>("portalDownloadRequest", "findMany", {
    where: { organizationId: fixtures.clientA.organizationId },
  });
  expect(rows).toHaveLength(0);
});
