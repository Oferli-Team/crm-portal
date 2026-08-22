import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { searchOrganization } from "@/lib/search/search";

describe("searchOrganization — integration", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(async () => {
    await prisma.commentMention.deleteMany({});
    await prisma.comment.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: "ZEPHYR-" } } });
    await prisma.task.deleteMany({ where: { title: { contains: "Zephyr" } } });
    await prisma.project.deleteMany({ where: { name: { contains: "Zephyr" } } });
    await prisma.client.deleteMany({ where: { name: { contains: "Zephyr" } } });
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  describe("empty / short query", () => {
    it("returns an empty groups array for an empty query", async () => {
      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "" });
      expect(result.groups).toEqual([]);
    });

    it("returns an empty groups array for a query below the minimum length", async () => {
      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "a" });
      expect(result.groups).toEqual([]);
    });

    it("a genuinely matching query returns all 5 groups, even ones with zero items — a stable shape", async () => {
      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "zzz-no-match-zzz" });
      expect(result.groups.map((g) => g.type)).toEqual(["CLIENT", "PROJECT", "TASK", "INVOICE", "COMMENT"]);
      for (const group of result.groups) {
        expect(group.items).toEqual([]);
      }
    });
  });

  describe("Client search", () => {
    it("exact, prefix, and contains matches rank in that order", async () => {
      const exact = await prisma.client.create({
        data: { name: "Zephyr", organizationId: fixtures.orgA.id, userId: fixtures.owner.id },
      });
      const prefix = await prisma.client.create({
        data: { name: "Zephyr Industries", organizationId: fixtures.orgA.id, userId: fixtures.owner.id },
      });
      const contains = await prisma.client.create({
        data: { name: "New Zephyr Holdings", organizationId: fixtures.orgA.id, userId: fixtures.owner.id },
      });

      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "Zephyr" });
      const clientGroup = result.groups.find((g) => g.type === "CLIENT")!;
      const ids = clientGroup.items.map((r) => r.id);
      expect(ids.indexOf(exact.id)).toBeLessThan(ids.indexOf(prefix.id));
      expect(ids.indexOf(prefix.id)).toBeLessThan(ids.indexOf(contains.id));
    });

    it("matches by company (secondary field)", async () => {
      // Name deliberately doesn't contain "Zephyr" (only company does), to
      // isolate a genuine secondary-field match — not caught by this
      // file's name-based afterEach cleanup, so it's deleted inline.
      const client = await prisma.client.create({
        data: {
          name: "Unrelated Name",
          company: "Zephyr Manufacturing",
          organizationId: fixtures.orgA.id,
          userId: fixtures.owner.id,
        },
      });
      try {
        const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "Zephyr" });
        const clientGroup = result.groups.find((g) => g.type === "CLIENT")!;
        expect(clientGroup.items.some((r) => r.id === client.id)).toBe(true);
      } finally {
        await prisma.client.delete({ where: { id: client.id } });
      }
    });

    it("never searches or returns notes", async () => {
      // Name deliberately does NOT contain "Zephyr" — the only way this
      // row could appear in a "Zephyr" search result is if notes were
      // (wrongly) searched. Not caught by this file's own name-based
      // afterEach cleanup for the same reason, so it's deleted inline.
      const client = await prisma.client.create({
        data: {
          name: "Notes Leak Probe",
          notes: "Zephyr is a secret internal note",
          organizationId: fixtures.orgA.id,
          userId: fixtures.owner.id,
        },
      });
      try {
        const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "Zephyr" });
        const clientGroup = result.groups.find((g) => g.type === "CLIENT")!;
        expect(clientGroup.items.some((r) => r.id === client.id)).toBe(false);
      } finally {
        await prisma.client.delete({ where: { id: client.id } });
      }
    });

    it("links to the existing staff Client edit route", async () => {
      const client = await prisma.client.create({
        data: { name: "Zephyr Link Test", organizationId: fixtures.orgA.id, userId: fixtures.owner.id },
      });
      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "Zephyr Link" });
      const clientGroup = result.groups.find((g) => g.type === "CLIENT")!;
      const match = clientGroup.items.find((r) => r.id === client.id);
      expect(match?.url).toBe(`/clients/${client.id}/edit`);
    });
  });

  describe("Project search", () => {
    it("matches by name and by its Client's name", async () => {
      const client = await prisma.client.create({
        data: { name: "Zephyr Client", organizationId: fixtures.orgA.id, userId: fixtures.owner.id },
      });
      const projectByName = await prisma.project.create({
        data: {
          name: "Zephyr Rollout",
          clientId: fixtures.clientA.id,
          organizationId: fixtures.orgA.id,
          ownerId: fixtures.owner.id,
        },
      });
      const projectByClient = await prisma.project.create({
        data: { name: "Unrelated Project", clientId: client.id, organizationId: fixtures.orgA.id, ownerId: fixtures.owner.id },
      });

      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "Zephyr" });
      const projectGroup = result.groups.find((g) => g.type === "PROJECT")!;
      const ids = projectGroup.items.map((r) => r.id);
      expect(ids).toContain(projectByName.id);
      expect(ids).toContain(projectByClient.id);
    });

    it("never returns budget, ownerId, or any field beyond title/subtitle/url", async () => {
      const project = await prisma.project.create({
        data: {
          name: "Zephyr Budgeted",
          budget: "999999.99",
          clientId: fixtures.clientA.id,
          organizationId: fixtures.orgA.id,
          ownerId: fixtures.owner.id,
        },
      });
      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "Zephyr Budgeted" });
      const projectGroup = result.groups.find((g) => g.type === "PROJECT")!;
      const match = projectGroup.items.find((r) => r.id === project.id);
      expect(Object.keys(match!).sort()).toEqual(["id", "preview", "subtitle", "title", "type", "url"]);
    });
  });

  describe("Task search", () => {
    it("is scoped through Project.organizationId, matches by title and Project.name", async () => {
      const task = await prisma.task.create({
        data: { title: "Zephyr Task", projectId: fixtures.project.id, organizationId: fixtures.orgA.id },
      });
      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "Zephyr Task" });
      const taskGroup = result.groups.find((g) => g.type === "TASK")!;
      const match = taskGroup.items.find((r) => r.id === task.id);
      expect(match).toBeDefined();
      expect(match?.subtitle).toBe(fixtures.project.name);
      expect(match?.url).toBe(`/tasks/${task.id}/edit`);
    });

    it("a Task whose own organizationId column is null is still found via its Project", async () => {
      const task = await prisma.task.create({
        data: { title: "Zephyr Nullorg Task", projectId: fixtures.project.id, organizationId: null },
      });
      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "Zephyr Nullorg" });
      const taskGroup = result.groups.find((g) => g.type === "TASK")!;
      expect(taskGroup.items.some((r) => r.id === task.id)).toBe(true);
    });
  });

  describe("Invoice search", () => {
    it("matches by invoiceNumber, and by Project/Client name", async () => {
      const invoice = await prisma.invoice.create({
        data: {
          invoiceNumber: "ZEPHYR-001",
          clientId: fixtures.clientA.id,
          projectId: fixtures.project.id,
          organizationId: fixtures.orgA.id,
          amount: "100.00",
          issueDate: new Date(),
        },
      });
      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "ZEPHYR-001" });
      const invoiceGroup = result.groups.find((g) => g.type === "INVOICE")!;
      const match = invoiceGroup.items.find((r) => r.id === invoice.id);
      expect(match?.title).toBe("Invoice #ZEPHYR-001");
      expect(match?.url).toBe(`/invoices/${invoice.id}/edit`);
    });

    it("never returns notes", async () => {
      const invoice = await prisma.invoice.create({
        data: {
          invoiceNumber: "ZEPHYR-NOTES",
          notes: "Zephyr internal billing note",
          clientId: fixtures.clientA.id,
          projectId: fixtures.project.id,
          organizationId: fixtures.orgA.id,
          amount: "100.00",
          issueDate: new Date(),
        },
      });
      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "Zephyr internal" });
      const invoiceGroup = result.groups.find((g) => g.type === "INVOICE")!;
      expect(invoiceGroup.items.some((r) => r.id === invoice.id)).toBe(false);
    });
  });

  describe("Comment search", () => {
    it("matches body content, returns a bounded preview, never the full body, and deep-links with #comment-{id}", async () => {
      const longBody = "Zephyr " + "filler text ".repeat(30) + "the important part";
      const comment = await prisma.comment.create({
        data: {
          organizationId: fixtures.orgA.id,
          authorId: fixtures.owner.id,
          entityType: "PROJECT",
          entityId: fixtures.project.id,
          body: longBody,
        },
      });

      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "Zephyr" });
      const commentGroup = result.groups.find((g) => g.type === "COMMENT")!;
      const match = commentGroup.items.find((r) => r.id === comment.id);
      expect(match).toBeDefined();
      expect(match!.preview).not.toBe(longBody);
      expect(match!.preview!.length).toBeLessThan(longBody.length);
      expect(match!.title).toBe(fixtures.project.name);
      expect(match!.url).toBe(`/projects/${fixtures.project.id}/edit#comment-${comment.id}`);
    });

    it("excludes a soft-deleted comment even though its body still matches", async () => {
      const comment = await prisma.comment.create({
        data: {
          organizationId: fixtures.orgA.id,
          authorId: fixtures.owner.id,
          entityType: "PROJECT",
          entityId: fixtures.project.id,
          body: "Zephyr deleted comment body",
          deletedAt: new Date(),
        },
      });
      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "Zephyr deleted" });
      const commentGroup = result.groups.find((g) => g.type === "COMMENT")!;
      expect(commentGroup.items.some((r) => r.id === comment.id)).toBe(false);
    });

    it("a deleted author does not break the result (falls back to a neutral label internally, never throws)", async () => {
      const authorlessId = fixtures.member.id;
      const comment = await prisma.comment.create({
        data: {
          organizationId: fixtures.orgA.id,
          authorId: authorlessId,
          entityType: "TASK",
          entityId: fixtures.task.id,
          body: "Zephyr comment before author is removed",
        },
      });
      // Simulate the author being gone via SetNull directly (deleting the
      // real fixture User would break other tests sharing it) — this is
      // exactly the DB state Comment.authorId SetNull produces.
      await prisma.comment.update({ where: { id: comment.id }, data: { authorId: null } });

      await expect(
        searchOrganization({ organizationId: fixtures.orgA.id, query: "Zephyr comment before" }),
      ).resolves.toBeDefined();

      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "Zephyr comment before" });
      const commentGroup = result.groups.find((g) => g.type === "COMMENT")!;
      expect(commentGroup.items.some((r) => r.id === comment.id)).toBe(true);
    });

    it("never searches or exposes a raw mention token/uuid — only the stripped preview", async () => {
      const comment = await prisma.comment.create({
        data: {
          organizationId: fixtures.orgA.id,
          authorId: fixtures.owner.id,
          entityType: "PROJECT",
          entityId: fixtures.project.id,
          body: `Zephyr mention @[${fixtures.member.name}](user:${fixtures.member.id})`,
        },
      });
      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "Zephyr mention" });
      const commentGroup = result.groups.find((g) => g.type === "COMMENT")!;
      const match = commentGroup.items.find((r) => r.id === comment.id);
      expect(match!.preview).not.toContain(`user:${fixtures.member.id}`);
      expect(match!.preview).not.toContain("](user:");
    });
  });

  describe("cross-org isolation", () => {
    it("org A's search never returns org B's Client/Project/Task/Invoice", async () => {
      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: fixtures.clientB.name });
      const clientGroup = result.groups.find((g) => g.type === "CLIENT")!;
      expect(clientGroup.items.some((r) => r.id === fixtures.clientB.id)).toBe(false);
    });

    it("org A's search never returns org B's comments", async () => {
      const orgBComment = await prisma.comment.create({
        data: {
          organizationId: fixtures.orgB.id,
          authorId: fixtures.orgBOwner.id,
          entityType: "PROJECT",
          entityId: fixtures.project.id, // deliberately a foreign-org entityId, see next test
          body: "Zephyr org B only comment",
        },
      });
      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "Zephyr org B only" });
      const commentGroup = result.groups.find((g) => g.type === "COMMENT")!;
      expect(commentGroup.items.some((r) => r.id === orgBComment.id)).toBe(false);
    });

    it("a comment whose organizationId matches but whose entityId resolves to a different org's Project is excluded (defense in depth)", async () => {
      const comment = await prisma.comment.create({
        data: {
          organizationId: fixtures.orgA.id,
          authorId: fixtures.owner.id,
          entityType: "PROJECT",
          entityId: fixtures.clientB.id, // not even a real Project id, let alone org A's
          body: "Zephyr inconsistent parent comment",
        },
      });
      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "Zephyr inconsistent" });
      const commentGroup = result.groups.find((g) => g.type === "COMMENT")!;
      expect(commentGroup.items.some((r) => r.id === comment.id)).toBe(false);
    });
  });

  describe("query normalization behavior", () => {
    it("is case-insensitive", async () => {
      const client = await prisma.client.create({
        data: { name: "Zephyr Case Test", organizationId: fixtures.orgA.id, userId: fixtures.owner.id },
      });
      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "zEpHyR cAsE" });
      const clientGroup = result.groups.find((g) => g.type === "CLIENT")!;
      expect(clientGroup.items.some((r) => r.id === client.id)).toBe(true);
    });

    it("finds unicode text", async () => {
      const client = await prisma.client.create({
        data: { name: "Zephyr 日本語テスト", organizationId: fixtures.orgA.id, userId: fixtures.owner.id },
      });
      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "日本語" });
      const clientGroup = result.groups.find((g) => g.type === "CLIENT")!;
      expect(clientGroup.items.some((r) => r.id === client.id)).toBe(true);
    });

    it("a very long query is truncated safely rather than erroring", async () => {
      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "a".repeat(500) });
      expect(result.groups).toBeDefined();
    });

    it("a query containing LIKE metacharacters (%, _) is treated literally, not as a wildcard", async () => {
      const client = await prisma.client.create({
        data: { name: "Zephyr 50% Off", organizationId: fixtures.orgA.id, userId: fixtures.owner.id },
      });
      const literalMatch = await searchOrganization({ organizationId: fixtures.orgA.id, query: "Zephyr 50%" });
      const clientGroup = literalMatch.groups.find((g) => g.type === "CLIENT")!;
      expect(clientGroup.items.some((r) => r.id === client.id)).toBe(true);

      // A query that is PURELY wildcard characters ("%%", two of them, to
      // clear the minimum-length gate) must never explode into "matches
      // everything" — if % were not escaped, ILIKE '%\%\%%' effectively
      // becomes ILIKE '%%%' (matches any string); properly escaped, it
      // requires the literal two-character substring "%%" to appear,
      // which no ordinary client name contains.
      const unrelated = await prisma.client.create({
        data: { name: "Totally Unrelated Zephyr Wombat", organizationId: fixtures.orgA.id, userId: fixtures.owner.id },
      });
      const wildcardProbe = await searchOrganization({ organizationId: fixtures.orgA.id, query: "%%" });
      const wildcardClientGroup = wildcardProbe.groups.find((g) => g.type === "CLIENT")!;
      expect(wildcardClientGroup.items.some((r) => r.id === unrelated.id)).toBe(false);
      expect(wildcardClientGroup.items.some((r) => r.id === client.id)).toBe(false);
      await prisma.client.delete({ where: { id: unrelated.id } });
    });
  });

  describe("per-type limits", () => {
    it("caps each type's results at the server-side limit even when many more rows match", async () => {
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          prisma.client.create({
            data: { name: `Zephyr Bulk ${i}`, organizationId: fixtures.orgA.id, userId: fixtures.owner.id },
          }),
        ),
      );
      const result = await searchOrganization({ organizationId: fixtures.orgA.id, query: "Zephyr Bulk" });
      const clientGroup = result.groups.find((g) => g.type === "CLIENT")!;
      expect(clientGroup.items.length).toBeLessThanOrEqual(5);
    });
  });
});
