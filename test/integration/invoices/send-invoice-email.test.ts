import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";
import { actAs, resetAuthMock } from "../../support/auth-mock";
import type { Role } from "@/generated/prisma/enums";

/**
 * Invoice System Official Slice 4, PR 4b — the live send-invoice-email
 * pipeline. Runs against the real repository database harness (PGlite),
 * mirroring test/integration/invoices/issue.test.ts's own structure and
 * conventions exactly (TEST_MODE set only here, dynamic imports after
 * that, real issueInvoice() reused rather than hand-seeding an "archived"
 * row for realism, dependency injection to control provider/PDF/readiness
 * outcomes without ever mocking Prisma itself).
 */

const ORIGINAL_TEST_MODE = process.env.TEST_MODE;
const ORIGINAL_FROM_EMAIL = process.env.INVITATION_FROM_EMAIL;
process.env.TEST_MODE = "1";
// checkEmailProviderReadiness() reports "ready" unconditionally under
// TEST_MODE (PR 4a's own contract), but sendEmailViaResend()'s "from"
// address is still read directly from this real env var — matching
// playwright.config.ts's own identical E2E value, so the real (TEST_MODE)
// provider path can actually be exercised end to end.
process.env.INVITATION_FROM_EMAIL = "Test <test@example.com>";

const { issueInvoice } = await import("@/lib/invoices/pdf/issue-invoice");
const { sendInvoiceEmail, STALE_PENDING_THRESHOLD_MS } = await import("@/lib/invoices/email/send-invoice-email");
const { sendInvoiceEmailAction } = await import("@/app/(dashboard)/invoices/[id]/edit/send-email-actions");
const { loadInvoiceEmailAttempts } = await import("@/lib/invoices/email/attempt-history");

afterAll(() => {
  if (ORIGINAL_TEST_MODE === undefined) delete process.env.TEST_MODE;
  else process.env.TEST_MODE = ORIGINAL_TEST_MODE;
  if (ORIGINAL_FROM_EMAIL === undefined) delete process.env.INVITATION_FROM_EMAIL;
  else process.env.INVITATION_FROM_EMAIL = ORIGINAL_FROM_EMAIL;
});

/** fixtures.clientA has no email by default (test/fixtures/seed.ts) — every describe block below gives it one, once, so seedDraftInvoice's default client is a realistic "has an email on file" Client unless a test explicitly overrides it. */
async function ensureDefaultClientHasEmail(fixtures: TestFixtures): Promise<void> {
  await prisma.client.update({ where: { id: fixtures.clientA.id }, data: { email: `clienta-${fixtures.runId}@example.com` } });
}

const INVOICE_NUMBER_PREFIX = "INV-SEND-EMAIL";

type DraftInvoiceOverrides = { status?: "DRAFT" | "SENT"; clientId?: string; dueDate?: Date | null };

async function seedDraftInvoice(fixtures: TestFixtures, overrides: DraftInvoiceOverrides = {}) {
  return prisma.invoice.create({
    data: {
      invoiceNumber: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}-${randomUUID().slice(0, 8)}`,
      status: "DRAFT",
      amount: "250.00",
      subtotal: "250.00",
      discountAmount: "0.00",
      taxAmount: "0.00",
      discountType: "NONE",
      taxLabel: "TAX",
      currency: "USD",
      issueDate: new Date("2026-01-01T00:00:00.000Z"),
      dueDate: new Date("2026-02-01T00:00:00.000Z"),
      projectId: fixtures.project.id,
      clientId: fixtures.clientA.id,
      organizationId: fixtures.orgA.id,
      ...overrides,
    },
  });
}

async function seedClientWithEmail(fixtures: TestFixtures, email: string | null, orgId: string = fixtures.orgA.id, userId: string = fixtures.owner.id) {
  return prisma.client.create({
    data: { name: "Send Email Test Client", organizationId: orgId, userId, email: email ?? undefined },
  });
}

function actorFor(fixtures: TestFixtures, user: { id: string; name: string }, role: Role, organizationId = fixtures.orgA.id) {
  return { organizationId, userId: user.id, userName: user.name, role };
}

/** Issues a fresh DRAFT invoice for real (real issueInvoice(), TEST_MODE storage) so "already-issued" tests exercise a genuinely archived row, never a hand-faked one. */
async function issueDraftInvoice(fixtures: TestFixtures, overrides: DraftInvoiceOverrides = {}) {
  const invoice = await seedDraftInvoice(fixtures, overrides);
  const result = await issueInvoice({
    actor: actorFor(fixtures, fixtures.owner, "OWNER"),
    invoiceId: invoice.id,
    expectedUpdatedAt: invoice.updatedAt.toISOString(),
  });
  if (!result.ok) throw new Error(`fixture setup failed: issueInvoice returned ${result.error}`);
  return prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
}

async function seedAttempt(invoiceId: string, overrides: { status?: "PENDING" | "ACCEPTED" | "FAILED" | "UNKNOWN"; idempotencyKey?: string; attemptedAt?: Date; recipientEmail?: string } = {}) {
  return prisma.invoiceEmailAttempt.create({
    data: {
      invoiceId,
      recipientEmail: overrides.recipientEmail ?? "existing@example.com",
      status: overrides.status ?? "PENDING",
      idempotencyKey: overrides.idempotencyKey ?? randomUUID(),
      attemptedAt: overrides.attemptedAt,
    },
  });
}

const okProvider = async () => ({ ok: true as const, messageId: "msg_test_123" });
const failedProvider = async () => ({ ok: false as const, reason: "provider_error" as const });
const networkErrorProvider = async () => ({ ok: false as const, reason: "network_error" as const });

describe("sendInvoiceEmail — Invoice System Official Slice 4, PR 4b", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
    await ensureDefaultClientHasEmail(fixtures);
  });

  afterAll(async () => {
    await prisma.invoiceEmailAttempt.deleteMany({ where: { invoice: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } } });
    await prisma.invoicePdfArchiveObject.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await prisma.client.deleteMany({ where: { name: "Send Email Test Client" } });
    await cleanupTestData(fixtures);
  });

  // --- already-issued successful send -----------------------------------------

  it("already-issued invoice: successful send settles ACCEPTED with the real provider message id/timestamp, and creates no Activity/Notification", async () => {
    const client = await seedClientWithEmail(fixtures, `recipient-${randomUUID().slice(0, 8)}@example.com`);
    const invoiceRow = await seedDraftInvoice(fixtures, { clientId: client.id });
    const issued = await issueInvoice({ actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoiceRow.id, expectedUpdatedAt: invoiceRow.updatedAt.toISOString() });
    expect(issued.ok).toBe(true);
    const activitiesBefore = await prisma.activity.count({ where: { entityType: "INVOICE", entityId: invoiceRow.id } });

    const fixedNow = new Date("2026-08-20T10:00:00.000Z");
    const result = await sendInvoiceEmail(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoiceRow.id, idempotencyKey: randomUUID() },
      { now: () => fixedNow, sendEmail: okProvider },
    );

    expect(result).toMatchObject({ ok: true, outcome: "ACCEPTED" });
    expect(result.ok && "invoiceFinalizedAt" in result ? result.invoiceFinalizedAt : undefined).toBeUndefined();

    if (!result.ok || result.outcome !== "ACCEPTED") throw new Error("unreachable");
    const attempt = await prisma.invoiceEmailAttempt.findUniqueOrThrow({ where: { id: result.attemptId } });
    expect(attempt.status).toBe("ACCEPTED");
    expect(attempt.providerMessageId).toBe("msg_test_123");
    expect(attempt.providerAcceptedAt?.toISOString()).toBe(fixedNow.toISOString());
    expect(attempt.recipientEmail).toBe(client.email);
    expect(attempt.failureReason).toBeNull();

    const activitiesAfter = await prisma.activity.count({ where: { entityType: "INVOICE", entityId: invoiceRow.id } });
    expect(activitiesAfter).toBe(activitiesBefore);
    const portalDownloads = await prisma.portalDownloadRequest.count({ where: { organizationId: fixtures.orgA.id } });
    expect(portalDownloads).toBe(0);
  });

  // --- DRAFT Issue + Send using the real Issue service ------------------------

  it("DRAFT target: Issue & Send reuses the real issueInvoice() service, transitions DRAFT -> SENT, and settles the email in the same request", async () => {
    const client = await seedClientWithEmail(fixtures, `draft-send-${randomUUID().slice(0, 8)}@example.com`);
    const invoice = await seedDraftInvoice(fixtures, { clientId: client.id });

    const result = await sendInvoiceEmail(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString(), idempotencyKey: randomUUID() },
      { sendEmail: okProvider },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.outcome).toBe("ACCEPTED");
    expect("invoiceFinalizedAt" in result && result.invoiceFinalizedAt).toBeTruthy();

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("SENT");

    // Exactly Issue's own one STATUS_CHANGED Activity — the email step adds none.
    const activities = await prisma.activity.findMany({ where: { entityType: "INVOICE", entityId: invoice.id, action: "STATUS_CHANGED" } });
    expect(activities).toHaveLength(1);

    const attempts = await prisma.invoiceEmailAttempt.findMany({ where: { invoiceId: invoice.id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("ACCEPTED");
  });

  it("DRAFT target: a stale expectedUpdatedAt is rejected before Issue is ever attempted — the invoice remains DRAFT, no attempt row", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const stale = new Date(invoice.updatedAt.getTime() - 60_000).toISOString();

    const result = await sendInvoiceEmail({ actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: stale, idempotencyKey: randomUUID() });

    expect(result).toEqual({ ok: false, error: "STALE_VERSION" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("DRAFT");
    expect(await prisma.invoiceEmailAttempt.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });

  // --- missing/invalid recipient: zero attempts, no Issue ----------------------

  it("missing recipient email on a DRAFT target: zero attempts created, and Issue never runs (invoice remains DRAFT)", async () => {
    const client = await seedClientWithEmail(fixtures, null);
    const invoice = await seedDraftInvoice(fixtures, { clientId: client.id });

    const result = await sendInvoiceEmail({ actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString(), idempotencyKey: randomUUID() });

    expect(result).toEqual({ ok: false, error: "NO_RECIPIENT_EMAIL" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("DRAFT");
    expect(await prisma.invoiceEmailAttempt.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });

  it("invalid-shaped recipient email on a DRAFT target: zero attempts, no Issue", async () => {
    const client = await seedClientWithEmail(fixtures, "not-an-email");
    const invoice = await seedDraftInvoice(fixtures, { clientId: client.id });

    const result = await sendInvoiceEmail({ actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString(), idempotencyKey: randomUUID() });

    expect(result).toEqual({ ok: false, error: "INVALID_RECIPIENT_EMAIL" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("DRAFT");
    expect(await prisma.invoiceEmailAttempt.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });

  it("recipient becomes invalid between Issue and dispatch: Invoice remains issued, ISSUED_EMAIL_NOT_SENT with no attempt row", async () => {
    const client = await seedClientWithEmail(fixtures, `valid-at-first-${randomUUID().slice(0, 8)}@example.com`);
    const invoice = await seedDraftInvoice(fixtures, { clientId: client.id });

    let issueRan = false;
    const result = await sendInvoiceEmail(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString(), idempotencyKey: randomUUID() },
      {
        issueOverrides: {
          afterUploadBeforeFinalize: async () => {
            issueRan = true;
            // Simulate a concurrent edit clearing the recipient email
            // between Issue's own upload and the fresh post-Issue reread.
            await prisma.client.update({ where: { id: client.id }, data: { email: null } });
          },
        },
      },
    );

    expect(issueRan).toBe(true);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.outcome).toBe("ISSUED_EMAIL_NOT_SENT");
    if (result.outcome !== "ISSUED_EMAIL_NOT_SENT") throw new Error("unreachable");
    expect(result.emailError).toBe("NO_RECIPIENT_EMAIL");
    expect(result).not.toHaveProperty("attemptId");

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("SENT");
    expect(await prisma.invoiceEmailAttempt.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });

  // --- provider readiness failure: zero attempts, no Issue ---------------------

  it("provider not ready on a DRAFT target: zero attempts, Issue never runs", async () => {
    const invoice = await seedDraftInvoice(fixtures);

    const result = await sendInvoiceEmail(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString(), idempotencyKey: randomUUID() },
      { checkReadiness: () => "not_configured" },
    );

    expect(result).toEqual({ ok: false, error: "EMAIL_NOT_CONFIGURED" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("DRAFT");
    expect(await prisma.invoiceEmailAttempt.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });

  it("provider becomes not-ready between Issue and dispatch: Invoice remains issued, ISSUED_EMAIL_NOT_SENT", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    let readinessCallCount = 0;

    const result = await sendInvoiceEmail(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString(), idempotencyKey: randomUUID() },
      { checkReadiness: () => { readinessCallCount += 1; return readinessCallCount === 1 ? "ready" : "not_configured"; } },
    );

    expect(readinessCallCount).toBe(2);
    expect(result).toMatchObject({ ok: true, outcome: "ISSUED_EMAIL_NOT_SENT", emailError: "EMAIL_NOT_CONFIGURED" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("SENT");
    expect(await prisma.invoiceEmailAttempt.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });

  // --- exact idempotent replay: no resend --------------------------------------

  it("an exact idempotent replay (same key, already ACCEPTED) returns the persisted result and never dispatches again", async () => {
    const invoice = await issueDraftInvoice(fixtures);
    const key = randomUUID();
    let dispatchCount = 0;
    const countingProvider = async () => { dispatchCount += 1; return { ok: true as const, messageId: "msg_once" }; };

    const first = await sendInvoiceEmail({ actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, idempotencyKey: key }, { sendEmail: countingProvider });
    expect(first).toMatchObject({ ok: true, outcome: "ACCEPTED" });

    const second = await sendInvoiceEmail({ actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, idempotencyKey: key }, { sendEmail: countingProvider });

    expect(dispatchCount).toBe(1);
    expect(second).toEqual(first);
    expect(await prisma.invoiceEmailAttempt.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });

  // --- fresh PENDING blocks -----------------------------------------------------

  it("a fresh PENDING attempt (any key) blocks a new-key request with ALREADY_PENDING, creating no second row", async () => {
    const invoice = await issueDraftInvoice(fixtures);
    await seedAttempt(invoice.id, { status: "PENDING", attemptedAt: new Date() });

    const result = await sendInvoiceEmail({ actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, idempotencyKey: randomUUID() });

    expect(result).toEqual({ ok: false, error: "ALREADY_PENDING" });
    expect(await prisma.invoiceEmailAttempt.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });

  it("the exact same key on a fresh PENDING row also returns ALREADY_PENDING", async () => {
    const invoice = await issueDraftInvoice(fixtures);
    const key = randomUUID();
    await seedAttempt(invoice.id, { status: "PENDING", idempotencyKey: key, attemptedAt: new Date() });

    const result = await sendInvoiceEmail({ actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, idempotencyKey: key });

    expect(result).toEqual({ ok: false, error: "ALREADY_PENDING" });
  });

  // --- stale PENDING becomes UNKNOWN, independently of the rest of the request -

  it("a stale PENDING attempt is swept to UNKNOWN, and a new key then requires acknowledgement of that exact row", async () => {
    const invoice = await issueDraftInvoice(fixtures);
    const fixedNow = new Date("2026-08-20T12:00:00.000Z");
    const stale = await seedAttempt(invoice.id, { status: "PENDING", attemptedAt: new Date(fixedNow.getTime() - STALE_PENDING_THRESHOLD_MS - 1_000) });

    const result = await sendInvoiceEmail(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, idempotencyKey: randomUUID() },
      { now: () => fixedNow },
    );

    expect(result).toEqual({ ok: false, error: "UNKNOWN_ACKNOWLEDGEMENT_REQUIRED" });
    const swept = await prisma.invoiceEmailAttempt.findUniqueOrThrow({ where: { id: stale.id } });
    expect(swept.status).toBe("UNKNOWN");
    expect(swept.failureReason).toBe("stale_no_settlement");
  });

  it("the sweep commits independently even though the request as a whole returns an acknowledgement error", async () => {
    const invoice = await issueDraftInvoice(fixtures);
    const fixedNow = new Date("2026-08-20T13:00:00.000Z");
    const stale = await seedAttempt(invoice.id, { status: "PENDING", attemptedAt: new Date(fixedNow.getTime() - STALE_PENDING_THRESHOLD_MS - 5_000) });

    await sendInvoiceEmail({ actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, idempotencyKey: randomUUID() }, { now: () => fixedNow });

    // Re-check directly — the sweep is a real, independently committed write, not merely implied by the returned error.
    const after = await prisma.invoiceEmailAttempt.findUniqueOrThrow({ where: { id: stale.id } });
    expect(after.status).toBe("UNKNOWN");
  });

  it("the exact same key that was just swept to UNKNOWN returns that outcome idempotently — no acknowledgement, no dispatch", async () => {
    const invoice = await issueDraftInvoice(fixtures);
    const fixedNow = new Date("2026-08-20T14:00:00.000Z");
    const key = randomUUID();
    await seedAttempt(invoice.id, { status: "PENDING", idempotencyKey: key, attemptedAt: new Date(fixedNow.getTime() - STALE_PENDING_THRESHOLD_MS - 1_000) });
    let dispatchCount = 0;

    const result = await sendInvoiceEmail(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, idempotencyKey: key },
      { now: () => fixedNow, sendEmail: async () => { dispatchCount += 1; return { ok: true as const }; } },
    );

    expect(result).toMatchObject({ ok: true, outcome: "UNKNOWN" });
    expect(dispatchCount).toBe(0);
  });

  it("new key + correct acknowledgement of the exact latest UNKNOWN row proceeds to dispatch", async () => {
    const invoice = await issueDraftInvoice(fixtures);
    const fixedNow = new Date("2026-08-20T15:00:00.000Z");
    const stale = await seedAttempt(invoice.id, { status: "PENDING", attemptedAt: new Date(fixedNow.getTime() - STALE_PENDING_THRESHOLD_MS - 1_000) });

    const result = await sendInvoiceEmail(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, idempotencyKey: randomUUID(), acknowledgedStaleAttemptId: stale.id },
      { now: () => fixedNow, sendEmail: okProvider },
    );

    expect(result).toMatchObject({ ok: true, outcome: "ACCEPTED" });
  });

  it("new key + wrong acknowledgement id is rejected without disclosure, and dispatches nothing", async () => {
    const invoice = await issueDraftInvoice(fixtures);
    const fixedNow = new Date("2026-08-20T16:00:00.000Z");
    await seedAttempt(invoice.id, { status: "PENDING", attemptedAt: new Date(fixedNow.getTime() - STALE_PENDING_THRESHOLD_MS - 1_000) });
    let dispatchCount = 0;

    const result = await sendInvoiceEmail(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, idempotencyKey: randomUUID(), acknowledgedStaleAttemptId: randomUUID() },
      { now: () => fixedNow, sendEmail: async () => { dispatchCount += 1; return { ok: true as const }; } },
    );

    expect(result).toEqual({ ok: false, error: "INVALID_UNKNOWN_ACKNOWLEDGEMENT" });
    expect(dispatchCount).toBe(0);
  });

  it("an acknowledgement id belonging to a different Invoice (same org) is rejected, not treated as this Invoice's own", async () => {
    const invoiceA = await issueDraftInvoice(fixtures);
    const invoiceB = await issueDraftInvoice(fixtures);
    const fixedNow = new Date("2026-08-20T17:00:00.000Z");
    await seedAttempt(invoiceA.id, { status: "PENDING", attemptedAt: new Date(fixedNow.getTime() - STALE_PENDING_THRESHOLD_MS - 1_000) });
    const foreignUnknown = await seedAttempt(invoiceB.id, { status: "UNKNOWN" });

    const result = await sendInvoiceEmail(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoiceA.id, idempotencyKey: randomUUID(), acknowledgedStaleAttemptId: foreignUnknown.id },
      { now: () => fixedNow },
    );

    expect(result).toEqual({ ok: false, error: "INVALID_UNKNOWN_ACKNOWLEDGEMENT" });
  });

  it("an acknowledgement id supplied when the latest attempt is not UNKNOWN at all is rejected", async () => {
    const invoice = await issueDraftInvoice(fixtures);

    const result = await sendInvoiceEmail({
      actor: actorFor(fixtures, fixtures.owner, "OWNER"),
      invoiceId: invoice.id,
      idempotencyKey: randomUUID(),
      acknowledgedStaleAttemptId: randomUUID(),
    });

    expect(result).toEqual({ ok: false, error: "INVALID_UNKNOWN_ACKNOWLEDGEMENT" });
  });

  // --- provider settlement outcomes --------------------------------------------

  it("a definitive provider rejection settles FAILED with the bounded reason — an attempt row exists, so this is ok:true outcome:FAILED, never a bare ok:false", async () => {
    const invoice = await issueDraftInvoice(fixtures);
    const result = await sendInvoiceEmail(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, idempotencyKey: randomUUID() },
      { sendEmail: failedProvider },
    );

    expect(result).toMatchObject({ ok: true, outcome: "FAILED" });
    if (!result.ok || result.outcome !== "FAILED") throw new Error("unreachable");
    const attempt = await prisma.invoiceEmailAttempt.findUniqueOrThrow({ where: { id: result.attemptId } });
    expect(attempt.status).toBe("FAILED");
    expect(attempt.failureReason).toBe("provider_error");
    expect(attempt.providerMessageId).toBeNull();
  });

  it("provider FAILED after a DRAFT Issue+Send preserves the issued state — outcome FAILED with invoiceFinalizedAt, never ISSUED_EMAIL_NOT_SENT (an attempt row genuinely exists)", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const result = await sendInvoiceEmail(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString(), idempotencyKey: randomUUID() },
      { sendEmail: failedProvider },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.outcome).toBe("FAILED");
    expect("invoiceFinalizedAt" in result && result.invoiceFinalizedAt).toBeTruthy();
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("SENT");
  });

  it("a network/timeout-ambiguous provider result settles UNKNOWN, never FAILED", async () => {
    const invoice = await issueDraftInvoice(fixtures);
    const result = await sendInvoiceEmail(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, idempotencyKey: randomUUID() },
      { sendEmail: networkErrorProvider },
    );

    expect(result).toMatchObject({ ok: true, outcome: "UNKNOWN" });
    if (!result.ok || result.outcome !== "UNKNOWN") throw new Error("unreachable");
    const attempt = await prisma.invoiceEmailAttempt.findUniqueOrThrow({ where: { id: result.attemptId } });
    expect(attempt.status).toBe("UNKNOWN");
  });

  it("a thrown provider call is treated identically to network_error — settles UNKNOWN, never escapes", async () => {
    const invoice = await issueDraftInvoice(fixtures);
    const result = await sendInvoiceEmail(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, idempotencyKey: randomUUID() },
      { sendEmail: async () => { throw new Error("simulated provider transport exception"); } },
    );

    expect(result).toMatchObject({ ok: true, outcome: "UNKNOWN" });
  });

  it("settlement race: something else accepts the attempt while dispatch is in flight — the reread returns the ACTUAL persisted state, never the presumed provider outcome", async () => {
    const invoice = await issueDraftInvoice(fixtures);
    const fixedAttemptId = randomUUID();

    const result = await sendInvoiceEmail(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, idempotencyKey: randomUUID() },
      {
        generateAttemptId: () => fixedAttemptId,
        sendEmail: async () => {
          // Simulate a concurrent settlement (e.g. another process's own
          // stale-sweep/settlement) winning the race while this provider
          // call is still "in flight" from this request's own perspective.
          await prisma.invoiceEmailAttempt.updateMany({ where: { id: fixedAttemptId }, data: { status: "ACCEPTED", providerMessageId: "raced_winner" } });
          return { ok: false as const, reason: "network_error" as const }; // this request's own view — must NOT be trusted
        },
      },
    );

    expect(result).toMatchObject({ ok: true, outcome: "ACCEPTED", attemptId: fixedAttemptId });
    const attempt = await prisma.invoiceEmailAttempt.findUniqueOrThrow({ where: { id: fixedAttemptId } });
    expect(attempt.providerMessageId).toBe("raced_winner");
  });

  it("settlement race: the attempt row vanishes entirely before settlement — bounded UNKNOWN, no thrown exception", async () => {
    const invoice = await issueDraftInvoice(fixtures);
    const fixedAttemptId = randomUUID();

    const result = await sendInvoiceEmail(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, idempotencyKey: randomUUID() },
      {
        generateAttemptId: () => fixedAttemptId,
        sendEmail: async () => {
          await prisma.invoiceEmailAttempt.delete({ where: { id: fixedAttemptId } });
          return { ok: true as const };
        },
      },
    );

    expect(result).toMatchObject({ ok: true, outcome: "UNKNOWN", attemptId: fixedAttemptId });
  });

  // --- archive/ledger/PDF-read failures are bounded ----------------------------

  it("a legacy_eligible (never actually archived) already-issued invoice returns ARCHIVE_NOT_AVAILABLE, an ordinary failure since Issue never ran this request", async () => {
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}-${randomUUID().slice(0, 8)}`,
        status: "SENT",
        amount: "100.00",
        subtotal: "100.00",
        discountAmount: "0.00",
        taxAmount: "0.00",
        projectId: fixtures.project.id,
        clientId: fixtures.clientA.id,
        organizationId: fixtures.orgA.id,
      },
    });

    const result = await sendInvoiceEmail({ actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, idempotencyKey: randomUUID() });

    expect(result).toEqual({ ok: false, error: "ARCHIVE_NOT_AVAILABLE" });
    expect(await prisma.invoiceEmailAttempt.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });

  it("a corrupted ledger row (no longer REFERENCED) on an already-issued invoice returns ARCHIVE_NOT_AVAILABLE", async () => {
    const invoice = await issueDraftInvoice(fixtures);
    await prisma.invoicePdfArchiveObject.updateMany({ where: { invoiceId: invoice.id }, data: { status: "CLEANED", cleanedAt: new Date() } });

    const result = await sendInvoiceEmail({ actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, idempotencyKey: randomUUID() });

    expect(result).toEqual({ ok: false, error: "ARCHIVE_NOT_AVAILABLE" });
  });

  it("a PDF byte-download failure on an already-issued invoice returns ARCHIVE_NOT_AVAILABLE", async () => {
    const invoice = await issueDraftInvoice(fixtures);
    const result = await sendInvoiceEmail(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, idempotencyKey: randomUUID() },
      { downloadPdf: async () => ({ ok: false, reason: "not_found" }) },
    );

    expect(result).toEqual({ ok: false, error: "ARCHIVE_NOT_AVAILABLE" });
  });

  it("a PDF byte-download failure after a DRAFT Issue+Send preserves the issued state — ISSUED_EMAIL_NOT_SENT, no attempt row", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const result = await sendInvoiceEmail(
      { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString(), idempotencyKey: randomUUID() },
      { downloadPdf: async () => ({ ok: false, reason: "not_found" }) },
    );

    expect(result).toMatchObject({ ok: true, outcome: "ISSUED_EMAIL_NOT_SENT", emailError: "ARCHIVE_NOT_AVAILABLE" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("SENT");
    expect(await prisma.invoiceEmailAttempt.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });

  // --- cross-organization and cross-invoice isolation --------------------------

  it("FORBIDDEN for a non-OWNER role, invoice untouched", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const adminResult = await sendInvoiceEmail({ actor: actorFor(fixtures, fixtures.admin, "ADMIN"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString(), idempotencyKey: randomUUID() });
    const memberResult = await sendInvoiceEmail({ actor: actorFor(fixtures, fixtures.member, "MEMBER"), invoiceId: invoice.id, expectedUpdatedAt: invoice.updatedAt.toISOString(), idempotencyKey: randomUUID() });

    expect(adminResult).toEqual({ ok: false, error: "FORBIDDEN" });
    expect(memberResult).toEqual({ ok: false, error: "FORBIDDEN" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("DRAFT");
  });

  it("a cross-organization invoiceId and a nonexistent invoiceId both return the identical NOT_FOUND result", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const crossOrgActor = actorFor(fixtures, fixtures.orgBOwner, "OWNER", fixtures.orgB.id);

    const crossOrgResult = await sendInvoiceEmail({ actor: crossOrgActor, invoiceId: invoice.id, idempotencyKey: randomUUID() });
    const nonexistentResult = await sendInvoiceEmail({ actor: crossOrgActor, invoiceId: randomUUID(), idempotencyKey: randomUUID() });

    expect(crossOrgResult).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(nonexistentResult).toEqual({ ok: false, error: "NOT_FOUND" });
  });

  it("a same-org, different-Invoice idempotencyKey collision resolves to bounded PERSISTENCE_FAILED, never disclosing the other Invoice's attempt", async () => {
    const invoiceA = await issueDraftInvoice(fixtures);
    const invoiceB = await issueDraftInvoice(fixtures);
    const sharedKey = randomUUID();
    await seedAttempt(invoiceA.id, { status: "ACCEPTED", idempotencyKey: sharedKey });

    const result = await sendInvoiceEmail({ actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoiceB.id, idempotencyKey: sharedKey });

    expect(result).toEqual({ ok: false, error: "PERSISTENCE_FAILED" });
    // The other Invoice's own attempt is completely untouched.
    const untouched = await prisma.invoiceEmailAttempt.findMany({ where: { invoiceId: invoiceA.id } });
    expect(untouched).toHaveLength(1);
    expect(untouched[0].status).toBe("ACCEPTED");
    // No new row was created for invoiceB either.
    expect(await prisma.invoiceEmailAttempt.count({ where: { invoiceId: invoiceB.id } })).toBe(0);
  });

  // --- concurrency --------------------------------------------------------------

  it("two concurrent requests with the SAME key against the same invoice: at most one dispatch; the loser may observe PENDING (ALREADY_PENDING) rather than necessarily the eventual terminal outcome", async () => {
    const invoice = await issueDraftInvoice(fixtures);
    const key = randomUUID();
    let dispatchCount = 0;
    const input = { actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, idempotencyKey: key };
    const overrides = { sendEmail: async () => { dispatchCount += 1; return { ok: true as const, messageId: `msg_${dispatchCount}` }; } };

    const [a, b] = await Promise.all([sendInvoiceEmail(input, overrides), sendInvoiceEmail(input, overrides)]);
    const results = [a, b];

    // Never more than one real dispatch for the same key, regardless of
    // which shape each side observed.
    expect(dispatchCount).toBe(1);
    expect(await prisma.invoiceEmailAttempt.count({ where: { invoiceId: invoice.id } })).toBe(1);

    // Per the corrected design: the loser of a same-key race may
    // legitimately observe the winner's still-PENDING row and return
    // ALREADY_PENDING — it is not guaranteed to observe the eventual
    // terminal outcome. Both succeeding with the identical attemptId is
    // also a valid outcome (the loser's own idempotency re-query ran after
    // the winner had already settled). No other shape is acceptable.
    const okOutcomes = results.filter((r) => r.ok);
    const alreadyPending = results.filter((r) => !r.ok && r.error === "ALREADY_PENDING");
    expect(okOutcomes.length + alreadyPending.length).toBe(2);
    if (okOutcomes.length === 2) {
      const [first, second] = okOutcomes;
      if (first.ok && second.ok && first.outcome !== "ISSUED_EMAIL_NOT_SENT" && second.outcome !== "ISSUED_EMAIL_NOT_SENT") {
        expect(first.attemptId).toBe(second.attemptId);
      }
    }
  });

  it("two concurrent requests with DIFFERENT keys against the same invoice: the partial index allows exactly one PENDING claim, the loser observes ALREADY_PENDING", async () => {
    const invoice = await issueDraftInvoice(fixtures);

    const [a, b] = await Promise.all([
      sendInvoiceEmail({ actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, idempotencyKey: randomUUID() }, { sendEmail: okProvider }),
      sendInvoiceEmail({ actor: actorFor(fixtures, fixtures.owner, "OWNER"), invoiceId: invoice.id, idempotencyKey: randomUUID() }, { sendEmail: okProvider }),
    ]);

    const results = [a, b];
    const pendingBlocked = results.filter((r) => !r.ok && r.error === "ALREADY_PENDING");
    const succeeded = results.filter((r) => r.ok);
    // The winner may already have settled (ACCEPTED) by the time this
    // assertion runs — the partial index guarantees exactly one row was
    // ever claimed, not that it's still observably PENDING at this instant.
    expect(pendingBlocked).toHaveLength(1);
    expect(succeeded).toHaveLength(1);
    expect(await prisma.invoiceEmailAttempt.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });
});

describe("sendInvoiceEmailAction — full-stack wiring (Server Action -> service)", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
    await ensureDefaultClientHasEmail(fixtures);
  });

  afterAll(async () => {
    await prisma.invoiceEmailAttempt.deleteMany({ where: { invoice: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } } });
    await prisma.invoicePdfArchiveObject.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await prisma.client.deleteMany({ where: { name: "Send Email Test Client" } });
    await cleanupTestData(fixtures);
  });

  it("OWNER can send via the real Server Action end to end (real Resend TEST_MODE short-circuit, real archived PDF)", async () => {
    const client = await seedClientWithEmail(fixtures, `action-${randomUUID().slice(0, 8)}@example.com`);
    const invoice = await seedDraftInvoice(fixtures, { clientId: client.id });
    actAs(fixtures.owner, fixtures.orgA.id);
    const result = await sendInvoiceEmailAction(invoice.id, randomUUID(), invoice.updatedAt.toISOString());
    resetAuthMock();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // Real (TEST_MODE) sendEmailViaResend always accepts — ACCEPTED end to end.
    expect(result.outcome).toBe("ACCEPTED");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("SENT");
  });

  it("ADMIN calling the real Server Action is rejected with FORBIDDEN", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    actAs(fixtures.admin, fixtures.orgA.id);
    const result = await sendInvoiceEmailAction(invoice.id, randomUUID(), invoice.updatedAt.toISOString());
    resetAuthMock();

    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("DRAFT");
  });

  it("MEMBER calling the real Server Action is rejected with FORBIDDEN", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    actAs(fixtures.member, fixtures.orgA.id);
    const result = await sendInvoiceEmailAction(invoice.id, randomUUID(), invoice.updatedAt.toISOString());
    resetAuthMock();

    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
  });
});

describe("loadInvoiceEmailAttempts — OWNER-only, tenant/invoice scoped, bounded, deterministic", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
    await ensureDefaultClientHasEmail(fixtures);
  });

  afterAll(async () => {
    await prisma.invoiceEmailAttempt.deleteMany({ where: { invoice: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } } });
    await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `${INVOICE_NUMBER_PREFIX}-${fixtures.runId}` } } });
    await cleanupTestData(fixtures);
  });

  it("OWNER can load the bounded history, newest first with a deterministic id tiebreak", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    const base = new Date("2026-08-20T09:00:00.000Z");
    // Two rows sharing the exact same attemptedAt — the id tiebreak must
    // still produce a stable, deterministic order.
    const tie1 = await seedAttempt(invoice.id, { attemptedAt: base, status: "ACCEPTED" });
    const tie2 = await seedAttempt(invoice.id, { attemptedAt: base, status: "FAILED" });
    await seedAttempt(invoice.id, { attemptedAt: new Date(base.getTime() - 60_000), status: "ACCEPTED" });

    const rows = await loadInvoiceEmailAttempts(actorFor(fixtures, fixtures.owner, "OWNER"), invoice.id);

    expect(rows).toHaveLength(3);
    const tieOrder = [tie1.id, tie2.id].sort().reverse();
    expect([rows[0].id, rows[1].id]).toEqual(tieOrder);
    expect(Object.keys(rows[0]).sort()).toEqual(["attemptedAt", "id", "recipientEmail", "status"].sort());
  });

  it("bounded to the latest 20 rows", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    // Terminal status — the partial index permits only one PENDING row per
    // invoice at a time, which is irrelevant to this bound/ordering test.
    for (let i = 0; i < 25; i++) {
      await seedAttempt(invoice.id, { status: "ACCEPTED", attemptedAt: new Date(Date.now() - i * 1000) });
    }

    const rows = await loadInvoiceEmailAttempts(actorFor(fixtures, fixtures.owner, "OWNER"), invoice.id);
    expect(rows).toHaveLength(20);
  });

  it("ADMIN/MEMBER are rejected — OWNER-only, matching the send path exactly", async () => {
    const invoice = await seedDraftInvoice(fixtures);
    await expect(loadInvoiceEmailAttempts(actorFor(fixtures, fixtures.admin, "ADMIN"), invoice.id)).rejects.toThrow();
    await expect(loadInvoiceEmailAttempts(actorFor(fixtures, fixtures.member, "MEMBER"), invoice.id)).rejects.toThrow();
  });

  it("a cross-org invoiceId never returns another organization's attempts", async () => {
    const invoiceA = await seedDraftInvoice(fixtures);
    await seedAttempt(invoiceA.id);

    const rows = await loadInvoiceEmailAttempts(actorFor(fixtures, fixtures.orgBOwner, "OWNER", fixtures.orgB.id), invoiceA.id);
    expect(rows).toHaveLength(0);
  });
});
