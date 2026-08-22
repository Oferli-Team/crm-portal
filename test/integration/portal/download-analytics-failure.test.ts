import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/portal/attachments/[id]/download/route";
import { recordPortalDownloadRequest } from "@/lib/client-portal/analytics-events";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { setMockAuthUser, resetAuthMock } from "../../support/auth-mock";
import { resetNavigationMock } from "../../support/navigation-mock";
import { setSignedUrlShouldFail, resetStorageMock } from "../../support/storage-mock";

/**
 * Portal Analytics persistence foundation (docs/analytics-architecture.md
 * §12, Slice 1) — isolated in its own file (module-level mock of
 * recordPortalDownloadRequest) so it can never contaminate
 * test/e2e/portal-download-analytics.spec.ts's or any other integration
 * test's real-write assertions. Calls the real, unmodified route
 * Handler directly — no logic extracted purely for testability — with
 * real seeded Prisma data, the real getCurrentPortalUser() resolution,
 * and the real verifyPortalAttachmentAccess() authorization logic. Only
 * the unavoidable external boundaries are mocked: Supabase Auth
 * (test/integration/setup-mocks.ts, shared by the whole suite) and
 * Supabase Storage's signed-URL step (test/support/storage-mock.ts) —
 * plus, in this file only, the analytics write helper itself.
 *
 * Playwright/TEST_MODE cannot force either of the two failures this file
 * proves ordering around: createAttachmentSignedUrl() always succeeds
 * under TEST_MODE (it points at a local fake-storage route instead of
 * ever calling real Storage), and there is no way to make the real
 * recordPortalDownloadRequest() fail from an authorized E2E request
 * without corrupting the database out from under the rest of the suite.
 * This is why this coverage lives here, supplementing
 * test/e2e/portal-download-analytics.spec.ts's real-redirect,
 * real-database-write coverage rather than replacing it.
 */
vi.mock("@/lib/client-portal/analytics-events", () => ({
  recordPortalDownloadRequest: vi.fn(async () => false),
}));

const mockedRecordPortalDownloadRequest = vi.mocked(recordPortalDownloadRequest);

function downloadRequest(attachmentId: string) {
  return GET(new Request(`http://localhost/api/portal/attachments/${attachmentId}/download`), {
    params: Promise.resolve({ id: attachmentId }),
  });
}

describe("portal attachment download route — analytics write ordering", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(async () => {
    resetAuthMock();
    resetNavigationMock();
    resetStorageMock();
    mockedRecordPortalDownloadRequest.mockClear();
    await prisma.portalDownloadRequest.deleteMany({ where: { organizationId: fixtures.orgA.id } });
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("a recordPortalDownloadRequest failure never blocks the real 307 redirect, and the helper is called exactly once for the correct organization", async () => {
    setMockAuthUser({ id: fixtures.portalUser.id, email: fixtures.portalUser.email });

    const response = await downloadRequest(fixtures.attachment.id);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).not.toBeNull();

    expect(mockedRecordPortalDownloadRequest).toHaveBeenCalledTimes(1);
    // Reference-identity checks, not toHaveBeenCalledWith(prisma, ...) —
    // see login-analytics-failure.test.ts's own comment on this exact
    // point: deep-equality against the real Prisma client overflows the
    // call stack, and `toBe` is the more precise assertion anyway.
    const [calledClient, calledOrganizationId] = mockedRecordPortalDownloadRequest.mock.calls[0];
    expect(calledClient).toBe(prisma);
    expect(calledOrganizationId).toBe(fixtures.clientA.organizationId);

    // The mocked helper reported failure — no row exists, proving this
    // isn't accidentally passing because a real write happened anyway.
    const rows = await prisma.portalDownloadRequest.findMany({ where: { organizationId: fixtures.clientA.organizationId } });
    expect(rows).toHaveLength(0);
  });

  it("a signed-URL generation failure returns the existing 502 response, is never followed by an analytics write, and creates no row", async () => {
    setMockAuthUser({ id: fixtures.portalUser.id, email: fixtures.portalUser.email });
    setSignedUrlShouldFail(true);

    const response = await downloadRequest(fixtures.attachment.id);

    expect(response.status).toBe(502);
    expect(mockedRecordPortalDownloadRequest).not.toHaveBeenCalled();

    const rows = await prisma.portalDownloadRequest.findMany({ where: { organizationId: fixtures.clientA.organizationId } });
    expect(rows).toHaveLength(0);
  });
});
