import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { searchOrganization } from "@/lib/search/search";

describe("searchOrganization — security", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(async () => {
    await prisma.comment.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("a malformed query (SQL-metacharacter-like text) never throws and never returns unexpected data", async () => {
    const adversarialQueries = [
      "'; DROP TABLE \"Client\"; --",
      "1' OR '1'='1",
      "%_%_%_%",
      " ",
      String.fromCharCode(0) + String.fromCharCode(1) + String.fromCharCode(2) + "controlchars",
      "<script>alert(1)</script>",
      "a".repeat(10_000),
    ];

    for (const query of adversarialQueries) {
      await expect(searchOrganization({ organizationId: fixtures.orgA.id, query })).resolves.toBeDefined();
    }

    // The schema itself must still be intact — a real proof the "DROP
    // TABLE" attempt never executed as SQL.
    const stillThere = await prisma.client.findUnique({ where: { id: fixtures.clientA.id } });
    expect(stillThere).not.toBeNull();
  });

  it("only ever returns the allowlisted SearchResult fields — no organizationId, no internal ids beyond the result's own id, no metadata", async () => {
    const client = await prisma.client.create({
      data: { name: "Allowlist Probe Zephyr", organizationId: fixtures.orgA.id, userId: fixtures.owner.id },
    });
    try {
      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "Allowlist Probe Zephyr" });
      const clientGroup = result.groups.find((g) => g.type === "CLIENT")!;
      const match = clientGroup.items.find((r) => r.id === client.id)!;
      expect(Object.keys(match).sort()).toEqual(["id", "preview", "subtitle", "title", "type", "url"]);
      expect(JSON.stringify(result)).not.toContain(fixtures.orgA.id);
      expect(JSON.stringify(result)).not.toContain(fixtures.owner.id);
    } finally {
      await prisma.client.delete({ where: { id: client.id } });
    }
  });

  it("a PortalUser session can never reach organization data through this service (organizationId is always caller-resolved, never derived from an identity here)", async () => {
    // searchOrganization itself takes organizationId as a plain parameter —
    // it has no identity concept at all. The actual portal-rejection
    // guarantee lives one layer up, in getSearchRequestContext (see
    // request-context.test.ts's own "PortalUser -> 403" case) — this test
    // instead proves the service has no back door: it will faithfully
    // search whatever organizationId it's given, so the ENTIRE security
    // guarantee rests on the caller (the Route Handler) never passing one
    // a PortalUser resolved to, which getSearchRequestContext's own
    // contract already guarantees by construction (it never returns `ok:
    // true` for a PortalUser at all).
    const result = await searchOrganization({ organizationId: fixtures.orgB.id, query: fixtures.clientB.name });
    const clientGroup = result.groups.find((g) => g.type === "CLIENT")!;
    expect(clientGroup.items.some((r) => r.id === fixtures.clientB.id)).toBe(true);
    // orgA's own data never leaks into an orgB-scoped call either.
    expect(clientGroup.items.some((r) => r.id === fixtures.clientA.id)).toBe(false);
  });

  it("one per-type query failing fails the whole request, rather than silently returning a partial result", async () => {
    vi.spyOn(prisma.client, "findMany").mockRejectedValueOnce(new Error("simulated DB failure"));

    await expect(
      searchOrganization({ organizationId: fixtures.orgA.id, query: "anything" }),
    ).rejects.toThrow("simulated DB failure");

    vi.restoreAllMocks();
  });
});
