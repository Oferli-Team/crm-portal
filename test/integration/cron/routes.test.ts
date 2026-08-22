import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";

// Same reasoning as test/unit/cron-auth.test.ts — src/lib/cron/auth.ts
// imports the real "server-only" marker package, which throws outside
// Next's own "react-server" resolve condition. Neutralizing the marker
// package itself doesn't touch requireCronAuth's real logic at all.
vi.mock("server-only", () => ({}));

// Bounded Archival Reconciliation/Cleanup — TEST_MODE is set ONLY here (see
// issue.test.ts's own header comment for why it is never set globally),
// restored in this file's own afterAll below, so both new routes' real
// probeInvoicePdfObject()/removeInvoicePdfObject() calls exercise the
// in-memory TEST_MODE store rather than requiring a real Supabase client.
// `@/lib/test-mode`'s own TEST_MODE export is a module-level const frozen
// at first import (see that module's own doc comment) — deliberately a
// dynamic import below, AFTER this assignment, rather than the ordinary
// static import this file used before: a static `import ... from
// "@/lib/test-mode"` is always hoisted above every other top-level
// statement regardless of its own textual position, which would freeze
// TEST_MODE=false before this line ever ran.
const ORIGINAL_TEST_MODE = process.env.TEST_MODE;
process.env.TEST_MODE = "1";

const { encodeTestModeIdentity, TEST_USER_COOKIE } = await import("@/lib/test-mode");
const { GET: deliveryGet } = await import("@/app/api/cron/notification-delivery/route");
const { GET: cleanupGet } = await import("@/app/api/cron/notification-cleanup/route");
const { GET: reconciliationGet } = await import("@/app/api/cron/invoice-pdf-reconciliation/route");
const { GET: reconciliationDryRunGet } = await import("@/app/api/cron/invoice-pdf-reconciliation/dry-run/route");
const { buildInvoicePdfStoragePath } = await import("@/lib/invoices/pdf/storage");

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;
const TEST_CRON_SECRET = "integration-test-cron-secret";

function cronRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, { headers: new Headers(headers) });
}

afterAll(() => {
  if (ORIGINAL_CRON_SECRET === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  }
  if (ORIGINAL_TEST_MODE === undefined) {
    delete process.env.TEST_MODE;
  } else {
    process.env.TEST_MODE = ORIGINAL_TEST_MODE;
  }
});

describe("cron routes — authorization (integration, real requireCronAuth + real Route Handlers)", () => {
  // Reset before EVERY test, not just once — the "CRON_SECRET unset" test
  // below deletes it mid-suite, and without re-establishing it here, that
  // would leak into every later test in this file.
  beforeEach(() => {
    process.env.CRON_SECRET = TEST_CRON_SECRET;
  });

  it("notification-delivery: rejects a request with no Authorization header (401)", async () => {
    const response = await deliveryGet(cronRequest("/api/cron/notification-delivery"));
    expect(response.status).toBe(401);
  });

  it("notification-delivery: rejects the wrong secret (401)", async () => {
    const response = await deliveryGet(
      cronRequest("/api/cron/notification-delivery", { authorization: "Bearer wrong-secret" }),
    );
    expect(response.status).toBe(401);
  });

  it("notification-delivery: accepts the correct bearer secret (200) and returns only an aggregate summary", async () => {
    const response = await deliveryGet(
      cronRequest("/api/cron/notification-delivery", { authorization: `Bearer ${TEST_CRON_SECRET}` }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["claimed", "deleted", "failed", "scanned", "sent", "skipped"]);
    for (const value of Object.values(body)) {
      expect(typeof value).toBe("number");
    }
  });

  it("notification-cleanup: rejects a request with no Authorization header (401)", async () => {
    const response = await cleanupGet(cronRequest("/api/cron/notification-cleanup"));
    expect(response.status).toBe(401);
  });

  it("notification-cleanup: rejects the wrong secret (401)", async () => {
    const response = await cleanupGet(
      cronRequest("/api/cron/notification-cleanup", { authorization: "Bearer wrong-secret" }),
    );
    expect(response.status).toBe(401);
  });

  it("notification-cleanup: accepts the correct bearer secret (200) and returns only an aggregate summary", async () => {
    const response = await cleanupGet(
      cronRequest("/api/cron/notification-cleanup", { authorization: `Bearer ${TEST_CRON_SECRET}` }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["claimed", "deleted", "failed", "scanned", "sent", "skipped"]);
  });

  it("with CRON_SECRET unset (simulating a misconfigured deployment), both routes safely reject even a plausible-looking bearer value", async () => {
    delete process.env.CRON_SECRET;
    const deliveryResponse = await deliveryGet(
      cronRequest("/api/cron/notification-delivery", { authorization: "Bearer anything" }),
    );
    const cleanupResponse = await cleanupGet(
      cronRequest("/api/cron/notification-cleanup", { authorization: "Bearer anything" }),
    );
    expect(deliveryResponse.status).toBe(401);
    expect(cleanupResponse.status).toBe(401);
  });

  it("a staff session cookie is never a substitute for the bearer secret — the route never reads cookies at all", async () => {
    const cookieValue = encodeTestModeIdentity({ id: "some-user-id", email: "owner@example.com" });
    const response = await deliveryGet(
      cronRequest("/api/cron/notification-delivery", { cookie: `${TEST_USER_COOKIE}=${cookieValue}` }),
    );
    expect(response.status).toBe(401);
  });

  // --- Bounded Archival Reconciliation/Cleanup — the real and dry-run routes ---

  it("invoice-pdf-reconciliation: rejects a request with no Authorization header (401)", async () => {
    const response = await reconciliationGet(cronRequest("/api/cron/invoice-pdf-reconciliation"));
    expect(response.status).toBe(401);
  });

  it("invoice-pdf-reconciliation: rejects the wrong secret (401)", async () => {
    const response = await reconciliationGet(
      cronRequest("/api/cron/invoice-pdf-reconciliation", { authorization: "Bearer wrong-secret" }),
    );
    expect(response.status).toBe(401);
  });

  it("invoice-pdf-reconciliation: with CRON_SECRET unset, rejects even a plausible-looking bearer value", async () => {
    delete process.env.CRON_SECRET;
    const response = await reconciliationGet(
      cronRequest("/api/cron/invoice-pdf-reconciliation", { authorization: "Bearer anything" }),
    );
    expect(response.status).toBe(401);
  });

  it("invoice-pdf-reconciliation: a staff session cookie is never a substitute for the bearer secret", async () => {
    const cookieValue = encodeTestModeIdentity({ id: "some-user-id", email: "owner@example.com" });
    const response = await reconciliationGet(
      cronRequest("/api/cron/invoice-pdf-reconciliation", { cookie: `${TEST_USER_COOKIE}=${cookieValue}` }),
    );
    expect(response.status).toBe(401);
  });

  it("invoice-pdf-reconciliation: accepts the correct bearer secret (200) and returns only the exact real-summary keys", async () => {
    const response = await reconciliationGet(
      cronRequest("/api/cron/invoice-pdf-reconciliation", { authorization: `Bearer ${TEST_CRON_SECRET}` }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(
      [
        "scanned",
        "claimed",
        "cleaned",
        "retained",
        "releasedWithFailure",
        "claimLost",
        "unexpectedFailures",
        "manualReviewPending",
        "inconsistentClaimState",
      ].sort(),
    );
    for (const value of Object.values(body)) {
      expect(typeof value).toBe("number");
    }
  });

  it("invoice-pdf-reconciliation/dry-run: rejects a request with no Authorization header (401)", async () => {
    const response = await reconciliationDryRunGet(cronRequest("/api/cron/invoice-pdf-reconciliation/dry-run"));
    expect(response.status).toBe(401);
  });

  it("invoice-pdf-reconciliation/dry-run: rejects the wrong secret (401)", async () => {
    const response = await reconciliationDryRunGet(
      cronRequest("/api/cron/invoice-pdf-reconciliation/dry-run", { authorization: "Bearer wrong-secret" }),
    );
    expect(response.status).toBe(401);
  });

  it("invoice-pdf-reconciliation/dry-run: a staff session cookie is never a substitute for the bearer secret", async () => {
    const cookieValue = encodeTestModeIdentity({ id: "some-user-id", email: "owner@example.com" });
    const response = await reconciliationDryRunGet(
      cronRequest("/api/cron/invoice-pdf-reconciliation/dry-run", { cookie: `${TEST_USER_COOKIE}=${cookieValue}` }),
    );
    expect(response.status).toBe(401);
  });

  it("invoice-pdf-reconciliation/dry-run: accepts the correct bearer secret (200) and returns only the exact dry-run-summary keys", async () => {
    const response = await reconciliationDryRunGet(
      cronRequest("/api/cron/invoice-pdf-reconciliation/dry-run", { authorization: `Bearer ${TEST_CRON_SECRET}` }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(
      [
        "scanned",
        "wouldCleanAbsent",
        "wouldRemovePresent",
        "wouldRetryProbeFailure",
        "wouldSkipInvariant",
        "manualReviewPending",
        "inconsistentClaimState",
      ].sort(),
    );
    for (const value of Object.values(body)) {
      expect(typeof value).toBe("number");
    }
    // No write-implying field (cleaned/retained/claimed/claimLost/etc.)
    // appears anywhere in the dry-run response.
    expect(body).not.toHaveProperty("cleaned");
    expect(body).not.toHaveProperty("claimed");
  });

  it("both reconciliation routes' own source calls requireCronAuth before checkRateLimit, and use distinct fixed rate-limit identifiers — checkRateLimit itself is globally stubbed to always allow in this integration harness (see test/integration/setup-mocks.ts), so ordering/isolation is proven at the source level here rather than by actually tripping a 429", async () => {
    const { readFileSync } = await import("node:fs");
    const realSource = readFileSync("src/app/api/cron/invoice-pdf-reconciliation/route.ts", "utf8");
    const dryRunSource = readFileSync("src/app/api/cron/invoice-pdf-reconciliation/dry-run/route.ts", "utf8");

    for (const source of [realSource, dryRunSource]) {
      const authIndex = source.indexOf("requireCronAuth(");
      const rateLimitIndex = source.indexOf("checkRateLimit(");
      expect(authIndex).toBeGreaterThan(-1);
      expect(rateLimitIndex).toBeGreaterThan(-1);
      expect(authIndex).toBeLessThan(rateLimitIndex);
    }

    expect(realSource).toContain('checkRateLimit(CRON_JOB_LIMIT, "invoice-pdf-reconciliation")');
    expect(dryRunSource).toContain('checkRateLimit(CRON_JOB_LIMIT, "invoice-pdf-reconciliation-dry-run")');
  });
});

describe("Bounded Archival Reconciliation/Cleanup — dry-run route is genuinely zero-write, and never affects the real route's own outcome", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
    process.env.CRON_SECRET = TEST_CRON_SECRET;
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("calling the dry-run route leaves an eligible ledger row byte-for-byte unchanged, then the real route processes it normally", async () => {
    const archiveId = "99999999-9999-4999-8999-999999999999";
    const oldCreatedAt = new Date(Date.now() - 31 * 60 * 1000); // older than SAFETY_WINDOW_MS (30 min)
    const path = buildInvoicePdfStoragePath({
      organizationId: fixtures.orgA.id,
      invoiceId: fixtures.invoice.id,
      documentVersion: 1,
      archiveId,
    });

    const seeded = await prisma.invoicePdfArchiveObject.create({
      data: {
        id: archiveId,
        organizationId: fixtures.orgA.id,
        invoiceId: fixtures.invoice.id,
        documentVersion: 1,
        storagePath: path,
        status: "PENDING_UPLOAD",
        createdAt: oldCreatedAt,
      },
    });

    const before = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: archiveId } });

    const dryRunResponse = await reconciliationDryRunGet(
      cronRequest("/api/cron/invoice-pdf-reconciliation/dry-run", { authorization: `Bearer ${TEST_CRON_SECRET}` }),
    );
    expect(dryRunResponse.status).toBe(200);
    const dryRunBody = await dryRunResponse.json();
    expect(dryRunBody.wouldCleanAbsent).toBeGreaterThanOrEqual(1); // TEST_MODE Storage is empty at this path — never uploaded

    const afterDryRun = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: archiveId } });
    expect(afterDryRun).toEqual(before);

    // The dry-run call above had zero effect — the real route still
    // processes this exact row normally afterward.
    const realResponse = await reconciliationGet(
      cronRequest("/api/cron/invoice-pdf-reconciliation", { authorization: `Bearer ${TEST_CRON_SECRET}` }),
    );
    expect(realResponse.status).toBe(200);
    const realBody = await realResponse.json();
    expect(realBody.cleaned).toBeGreaterThanOrEqual(1);

    const afterReal = await prisma.invoicePdfArchiveObject.findUniqueOrThrow({ where: { id: archiveId } });
    expect(afterReal.status).toBe("CLEANED");
    expect(afterReal.cleanedAt).not.toBeNull();

    void seeded;
  });
});
