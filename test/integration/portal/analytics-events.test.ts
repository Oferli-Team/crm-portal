import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { recordPortalLogin, recordPortalDownloadRequest } from "@/lib/client-portal/analytics-events";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";

/**
 * Portal Analytics persistence foundation (docs/analytics-architecture.md
 * §12, Slice 1) — direct tests of the write-helper module, real Prisma
 * against the real test Postgres, no mocking. These are the tests that
 * would otherwise be duplicated across every call site
 * (portalLogin/acceptClientInvitationAction/the download route) — testing
 * the helper once, thoroughly, here.
 */
describe("recordPortalLogin", () => {
  let fixtures: TestFixtures;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleErrorSpy.mockRestore();
    await prisma.portalUser.update({ where: { id: fixtures.portalUser.id }, data: { lastLoginAt: null } });
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("writes the exact, deterministic occurredAt passed in", async () => {
    const occurredAt = new Date("2026-08-05T12:00:00.000Z");

    const result = await recordPortalLogin(prisma, fixtures.portalUser.id, occurredAt);

    expect(result).toBe(true);
    const updated = await prisma.portalUser.findUniqueOrThrow({ where: { id: fixtures.portalUser.id } });
    expect(updated.lastLoginAt?.toISOString()).toBe(occurredAt.toISOString());
  });

  it("overwrites an earlier lastLoginAt with a later one", async () => {
    await recordPortalLogin(prisma, fixtures.portalUser.id, new Date("2026-08-05T12:00:00.000Z"));
    await recordPortalLogin(prisma, fixtures.portalUser.id, new Date("2026-08-10T09:00:00.000Z"));

    const updated = await prisma.portalUser.findUniqueOrThrow({ where: { id: fixtures.portalUser.id } });
    expect(updated.lastLoginAt?.toISOString()).toBe(new Date("2026-08-10T09:00:00.000Z").toISOString());
  });

  it("returns false, never throws, for a nonexistent PortalUser id — and logs only the fixed sanitized message", async () => {
    const bogusId = randomUUID();

    const result = await recordPortalLogin(prisma, bogusId, new Date());

    expect(result).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith("[portal-analytics] Failed to record portal login.");
    // No identifier of any kind — not the bogus id, not a Prisma error
    // object, not a stack trace — ever reaches the logged output.
    const loggedArgs = consoleErrorSpy.mock.calls.flat();
    expect(loggedArgs).toHaveLength(1);
    expect(String(loggedArgs[0])).not.toContain(bogusId);
  });
});

describe("recordPortalDownloadRequest", () => {
  let fixtures: TestFixtures;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleErrorSpy.mockRestore();
    await prisma.portalDownloadRequest.deleteMany({
      where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } },
    });
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("creates exactly one row with the deterministic requestedAt passed in", async () => {
    const requestedAt = new Date("2026-08-12T08:30:00.000Z");

    const result = await recordPortalDownloadRequest(prisma, fixtures.orgA.id, requestedAt);

    expect(result).toBe(true);
    const rows = await prisma.portalDownloadRequest.findMany({ where: { organizationId: fixtures.orgA.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].requestedAt.toISOString()).toBe(requestedAt.toISOString());
  });

  it("two calls create two separate, immutable rows — never merged or incremented", async () => {
    await recordPortalDownloadRequest(prisma, fixtures.orgA.id, new Date("2026-08-12T08:30:00.000Z"));
    await recordPortalDownloadRequest(prisma, fixtures.orgA.id, new Date("2026-08-12T08:31:00.000Z"));

    const count = await prisma.portalDownloadRequest.count({ where: { organizationId: fixtures.orgA.id } });
    expect(count).toBe(2);
  });

  it("different organizations remain isolated from each other", async () => {
    await recordPortalDownloadRequest(prisma, fixtures.orgA.id, new Date());
    await recordPortalDownloadRequest(prisma, fixtures.orgB.id, new Date());
    await recordPortalDownloadRequest(prisma, fixtures.orgB.id, new Date());

    const [countA, countB] = await Promise.all([
      prisma.portalDownloadRequest.count({ where: { organizationId: fixtures.orgA.id } }),
      prisma.portalDownloadRequest.count({ where: { organizationId: fixtures.orgB.id } }),
    ]);
    expect(countA).toBe(1);
    expect(countB).toBe(2);
  });

  it("returns false, never throws, for a nonexistent organization id — and logs only the fixed sanitized message", async () => {
    const bogusOrgId = randomUUID();

    const result = await recordPortalDownloadRequest(prisma, bogusOrgId, new Date());

    expect(result).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith("[portal-analytics] Failed to record portal download-link request.");
    const loggedArgs = consoleErrorSpy.mock.calls.flat();
    expect(loggedArgs).toHaveLength(1);
    expect(String(loggedArgs[0])).not.toContain(bogusOrgId);

    const rows = await prisma.portalDownloadRequest.findMany({ where: { organizationId: bogusOrgId } });
    expect(rows).toHaveLength(0);
  });
});
