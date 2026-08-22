import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createClientAction } from "@/app/(dashboard)/clients/new/actions";
import { updateClientAction } from "@/app/(dashboard)/clients/[id]/edit/actions";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import { RedirectSignal } from "../../support/navigation-mock";

/**
 * Invoice System Slice 1 — Client billing identity write path
 * (docs/invoicing-architecture.md §4.4). Proves the real
 * createClientAction/updateClientAction Server Actions read/write the
 * seven optional billing fields correctly, scoped by the same
 * organization authorization the rest of Client already has, and that
 * Activity never carries a billing value — only field names, matching
 * this codebase's established privacy convention for Client Activity
 * metadata (src/lib/activity/client-metadata.ts).
 */

const CLIENT_NAME_PREFIX = "Slice1 Billing Client";

function buildClientFormData(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return formData;
}

async function expectRedirect(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(RedirectSignal);
}

describe("Client billing identity — real create/edit write path", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { name: { startsWith: `${CLIENT_NAME_PREFIX} ${fixtures.runId}` } } });
    await cleanupTestData(fixtures);
  });

  it("create persists every billing field in the authenticated organization", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const name = `${CLIENT_NAME_PREFIX} ${fixtures.runId} create ${randomUUID().slice(0, 8)}`;

    await expectRedirect(
      createClientAction(
        { error: null },
        buildClientFormData({
          name,
          billingLegalName: "Acme Corporation, LLC",
          taxId: "EU123456789",
          streetAddress: "123 Main St",
          city: "Springfield",
          state: "IL",
          postalCode: "62704",
          country: "United States",
        }),
      ),
    );
    resetAuthMock();

    const created = await prisma.client.findFirstOrThrow({ where: { name } });
    expect(created.organizationId).toBe(fixtures.orgA.id);
    expect(created.billingLegalName).toBe("Acme Corporation, LLC");
    expect(created.taxId).toBe("EU123456789");
    expect(created.streetAddress).toBe("123 Main St");
    expect(created.city).toBe("Springfield");
    expect(created.state).toBe("IL");
    expect(created.postalCode).toBe("62704");
    expect(created.country).toBe("United States");
  });

  it("existing create submissions without any billing field still succeed and normalize to null", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const name = `${CLIENT_NAME_PREFIX} ${fixtures.runId} bare ${randomUUID().slice(0, 8)}`;

    await expectRedirect(createClientAction({ error: null }, buildClientFormData({ name })));
    resetAuthMock();

    const created = await prisma.client.findFirstOrThrow({ where: { name } });
    expect(created.billingLegalName).toBeNull();
    expect(created.taxId).toBeNull();
    expect(created.streetAddress).toBeNull();
    expect(created.city).toBeNull();
    expect(created.state).toBeNull();
    expect(created.postalCode).toBeNull();
    expect(created.country).toBeNull();
  });

  it("edit reads and updates billing fields", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const name = `${CLIENT_NAME_PREFIX} ${fixtures.runId} edit ${randomUUID().slice(0, 8)}`;
    await expectRedirect(
      createClientAction({ error: null }, buildClientFormData({ name, taxId: "OLD-TAX-ID" })),
    );
    const created = await prisma.client.findFirstOrThrow({ where: { name } });
    expect(created.taxId).toBe("OLD-TAX-ID");

    await expectRedirect(
      updateClientAction(created.id, { error: null }, buildClientFormData({ name, taxId: "NEW-TAX-ID", city: "Chicago" })),
    );
    resetAuthMock();

    const updated = await prisma.client.findUniqueOrThrow({ where: { id: created.id } });
    expect(updated.taxId).toBe("NEW-TAX-ID");
    expect(updated.city).toBe("Chicago");
  });

  it("clearing billing fields on edit stores null", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const name = `${CLIENT_NAME_PREFIX} ${fixtures.runId} clear ${randomUUID().slice(0, 8)}`;
    await expectRedirect(
      createClientAction(
        { error: null },
        buildClientFormData({ name, taxId: "SOME-TAX-ID", city: "Springfield" }),
      ),
    );
    const created = await prisma.client.findFirstOrThrow({ where: { name } });
    expect(created.taxId).toBe("SOME-TAX-ID");

    // Resubmitting with the billing fields blank clears them to null.
    await expectRedirect(updateClientAction(created.id, { error: null }, buildClientFormData({ name })));
    resetAuthMock();

    const cleared = await prisma.client.findUniqueOrThrow({ where: { id: created.id } });
    expect(cleared.taxId).toBeNull();
    expect(cleared.city).toBeNull();
  });

  it("cross-organization edit is rejected — a foreign org's client id resolves as not found", async () => {
    actAs(fixtures.orgBOwner, fixtures.orgB.id);

    const result = await updateClientAction(
      fixtures.clientA.id,
      { error: null },
      buildClientFormData({ name: fixtures.clientA.name, taxId: "SHOULD-NOT-APPLY" }),
    );
    resetAuthMock();

    expect(result).toEqual({ error: "This client could not be found." });
    const unchanged = await prisma.client.findUniqueOrThrow({ where: { id: fixtures.clientA.id } });
    expect(unchanged.taxId).not.toBe("SHOULD-NOT-APPLY");
  });

  it("Activity is emitted for a real billing-field change, with only the field name — never the value", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const name = `${CLIENT_NAME_PREFIX} ${fixtures.runId} activity ${randomUUID().slice(0, 8)}`;
    await expectRedirect(createClientAction({ error: null }, buildClientFormData({ name })));
    const created = await prisma.client.findFirstOrThrow({ where: { name } });

    const secretTaxId = "SECRET-TAX-ID-98765";
    const secretAddress = "999 Confidential Ave";
    await expectRedirect(
      updateClientAction(
        created.id,
        { error: null },
        buildClientFormData({ name, taxId: secretTaxId, streetAddress: secretAddress }),
      ),
    );
    resetAuthMock();

    const activity = await prisma.activity.findFirstOrThrow({
      where: { entityId: created.id, entityType: "CLIENT", action: "UPDATED" },
      orderBy: { createdAt: "desc" },
    });
    const metadata = activity.metadata as Record<string, unknown>;
    expect(metadata.changedFields).toContain("taxId");
    expect(metadata.changedFields).toContain("streetAddress");

    const serializedMetadata = JSON.stringify(metadata);
    expect(serializedMetadata).not.toContain(secretTaxId);
    expect(serializedMetadata).not.toContain(secretAddress);
  });

  it("a no-op resubmit (identical values) emits no Activity", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const name = `${CLIENT_NAME_PREFIX} ${fixtures.runId} noop ${randomUUID().slice(0, 8)}`;
    await expectRedirect(
      createClientAction({ error: null }, buildClientFormData({ name, taxId: "STABLE-TAX-ID", city: "Springfield" })),
    );
    const created = await prisma.client.findFirstOrThrow({ where: { name } });

    const activityCountBefore = await prisma.activity.count({ where: { entityId: created.id, action: "UPDATED" } });

    await expectRedirect(
      updateClientAction(
        created.id,
        { error: null },
        buildClientFormData({ name, taxId: "STABLE-TAX-ID", city: "Springfield" }),
      ),
    );
    resetAuthMock();

    const activityCountAfter = await prisma.activity.count({ where: { entityId: created.id, action: "UPDATED" } });
    expect(activityCountAfter).toBe(activityCountBefore);
  });
});
