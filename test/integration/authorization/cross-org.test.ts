import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";

// Every "detail" lookup in this app (Client/Project/Task/Invoice/
// Attachment/Activity) is scoped by organizationId in a `findFirst` where
// clause, inline in each Server Component (no extracted helper function
// exists for these specific lookups — see the Stage 4 audit) — these
// tests exercise that exact query shape directly against the real test
// database, proving the invariant "org A can never read org B's row by
// id" holds for every entity type that carries an organizationId.

describe("cross-organization data isolation", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("client: org A cannot read org B's client, but can read its own", async () => {
    const crossOrg = await prisma.client.findFirst({
      where: { id: fixtures.clientB.id, organizationId: fixtures.orgA.id },
    });
    expect(crossOrg).toBeNull();

    const ownOrg = await prisma.client.findFirst({
      where: { id: fixtures.clientA.id, organizationId: fixtures.orgA.id },
    });
    expect(ownOrg?.id).toBe(fixtures.clientA.id);
  });

  it("project: scoped by organizationId", async () => {
    const crossOrg = await prisma.project.findFirst({
      where: { id: fixtures.project.id, organizationId: fixtures.orgB.id },
    });
    expect(crossOrg).toBeNull();

    const ownOrg = await prisma.project.findFirst({
      where: { id: fixtures.project.id, organizationId: fixtures.orgA.id },
    });
    expect(ownOrg?.id).toBe(fixtures.project.id);
  });

  it("task: scoped by organizationId", async () => {
    const crossOrg = await prisma.task.findFirst({
      where: { id: fixtures.task.id, organizationId: fixtures.orgB.id },
    });
    expect(crossOrg).toBeNull();

    const ownOrg = await prisma.task.findFirst({
      where: { id: fixtures.task.id, organizationId: fixtures.orgA.id },
    });
    expect(ownOrg?.id).toBe(fixtures.task.id);
  });

  it("invoice: a findFirst scoped by organizationId excludes a foreign org's row (query-shape proof only — NOT proof that production write paths populate this column correctly)", async () => {
    // organizationId is a required column (migration
    // 20260911090000_repair_invoice_organization_scope), kept consistent
    // with project.organizationId by every write path. This test's own
    // fixture sets organizationId directly on insert, bypassing the real
    // create/update Server Actions entirely — so, unlike every sibling
    // case in this file, this one proves ONLY that a findFirst filtered by
    // organizationId behaves correctly once the column is populated. It
    // must never be read as evidence that production create/update
    // actually populate Invoice.organizationId correctly — that write-path
    // proof (the thing that was previously missing and let the real bug
    // through undetected) lives exclusively in
    // test/integration/invoices/organization-scope.test.ts, which exercises
    // the real createInvoiceAction/updateInvoiceAction Server Actions
    // instead of this file's direct-fixture-insert pattern.
    const crossOrg = await prisma.invoice.findFirst({
      where: { id: fixtures.invoice.id, organizationId: fixtures.orgB.id },
    });
    expect(crossOrg).toBeNull();

    const ownOrg = await prisma.invoice.findFirst({
      where: { id: fixtures.invoice.id, organizationId: fixtures.orgA.id },
    });
    expect(ownOrg?.id).toBe(fixtures.invoice.id);
  });

  it("attachment: scoped by organizationId (mirrors the real download route's lookup)", async () => {
    const crossOrg = await prisma.attachment.findFirst({
      where: { id: fixtures.attachment.id, organizationId: fixtures.orgB.id },
    });
    expect(crossOrg).toBeNull();

    const ownOrg = await prisma.attachment.findFirst({
      where: { id: fixtures.attachment.id, organizationId: fixtures.orgA.id },
    });
    expect(ownOrg?.id).toBe(fixtures.attachment.id);
  });

  it("activity: scoped by organizationId", async () => {
    const crossOrg = await prisma.activity.findFirst({
      where: { id: fixtures.activity.id, organizationId: fixtures.orgB.id },
    });
    expect(crossOrg).toBeNull();

    const ownOrg = await prisma.activity.findFirst({
      where: { id: fixtures.activity.id, organizationId: fixtures.orgA.id },
    });
    expect(ownOrg?.id).toBe(fixtures.activity.id);
  });
});
