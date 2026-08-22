import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { updatePaymentDetailsAction } from "@/app/(dashboard)/settings/payment/actions";
import { getPaymentDetails } from "@/lib/organization-setup/payment-details";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";

function paymentForm(fields: Partial<{ bankName: string; accountHolder: string; accountNumber: string; swiftBic: string; paymentInstructions: string }> = {}): FormData {
  const fd = new FormData();
  fd.set("bankName", fields.bankName ?? "First National Bank");
  fd.set("accountHolder", fields.accountHolder ?? "Acme Inc.");
  fd.set("accountNumber", fields.accountNumber ?? "GB29NWBK60161331926819");
  fd.set("swiftBic", fields.swiftBic ?? "NWBKGB2L");
  if (fields.paymentInstructions !== undefined) fd.set("paymentInstructions", fields.paymentInstructions);
  return fd;
}

describe("Payment Details — Customer Setup Wizard (Stage 6.2)", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(async () => {
    resetAuthMock();
    await prisma.organizationPaymentDetails.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  it("OWNER can create and update payment details", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const created = await updatePaymentDetailsAction({ error: null }, paymentForm({ bankName: "First Bank" }));
    expect(created.error).toBeNull();

    const updated = await updatePaymentDetailsAction({ error: null }, paymentForm({ bankName: "Second Bank" }));
    expect(updated.error).toBeNull();

    const rows = await prisma.organizationPaymentDetails.findMany({ where: { organizationId: fixtures.orgA.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].bankName).toBe("Second Bank");
  });

  it("MEMBER cannot access payment settings — the write action rejects them and nothing is written", async () => {
    actAs(fixtures.member, fixtures.orgA.id);
    const result = await updatePaymentDetailsAction({ error: null }, paymentForm());
    expect(result.error).toBe("Payment details are only available to the organization owner.");
    const row = await prisma.organizationPaymentDetails.findUnique({ where: { organizationId: fixtures.orgA.id } });
    expect(row).toBeNull();
  });

  it("ADMIN cannot access payment settings either — this boundary is stricter than the OWNER/ADMIN split elsewhere in this app", async () => {
    actAs(fixtures.admin, fixtures.orgA.id);
    const result = await updatePaymentDetailsAction({ error: null }, paymentForm());
    expect(result.error).toBe("Payment details are only available to the organization owner.");
  });

  it("a Client Portal identity has no reachable action here at all", async () => {
    actAs({ id: fixtures.portalUser.id, email: fixtures.portalUser.email }, fixtures.orgA.id);
    await expect(updatePaymentDetailsAction({ error: null }, paymentForm())).rejects.toThrow("REDIRECT:/portal");
  });

  it("Organization A cannot access Organization B's payment details", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    await updatePaymentDetailsAction({ error: null }, paymentForm({ bankName: "Org A Bank" }));

    const orgBDetails = await getPaymentDetails(fixtures.orgB.id);
    expect(orgBDetails).toBeNull();

    const orgADetails = await getPaymentDetails(fixtures.orgA.id);
    expect(orgADetails?.bankName).toBe("Org A Bank");
  });

  it("rejects an invalid submission with field errors, and writes nothing", async () => {
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await updatePaymentDetailsAction({ error: null }, paymentForm({ bankName: "" }));
    expect(result.fieldErrors?.bankName).toBeTruthy();
    const row = await prisma.organizationPaymentDetails.findUnique({ where: { organizationId: fixtures.orgA.id } });
    expect(row).toBeNull();
  });
});
