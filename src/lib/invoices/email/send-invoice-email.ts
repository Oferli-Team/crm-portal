import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { assertCanAccessPaymentDetails, OrganizationSetupAccessError } from "@/lib/organization-setup/authorization";
import { issueInvoice, type IssueInvoiceDeps } from "@/lib/invoices/pdf/issue-invoice";
import type { TrustedInvoiceActor } from "@/lib/invoices/lifecycle";
import { classifyInvoiceArchival } from "@/lib/invoices/pdf/classify-archival";
import { parseIssuerSnapshot, parseRecipientSnapshot } from "@/lib/invoices/pdf/snapshot-types";
import {
  buildInvoicePdfDownloadFilename,
  buildInvoicePdfStoragePath,
  downloadInvoicePdfObject,
  type InvoicePdfObjectIdentity,
} from "@/lib/invoices/pdf/storage";
import { buildInvoiceEmailContent } from "./view-model";
import { resolveTrustedInvoiceEmailOrigin } from "./trusted-origin";
import { buildEmailLegalFooterHtml, buildEmailLegalFooterText } from "@/lib/email/legal-footer";
import { checkEmailProviderReadiness, sendEmailViaResend } from "@/lib/email/resend-client";
import { mapInvoiceEmailAttemptWriteError } from "./conflict-mapper";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const STALE_PENDING_THRESHOLD_MS = 120_000;
const PROVIDER_TIMEOUT_MS = 20_000;

export type SendInvoiceEmailInput = {
  actor: TrustedInvoiceActor;
  invoiceId: string;
  expectedUpdatedAt?: string;
  idempotencyKey: string;
  acknowledgedStaleAttemptId?: string;
};

export type PostIssueEmailFailureCode =
  | "EMAIL_NOT_CONFIGURED"
  | "NO_RECIPIENT_EMAIL"
  | "INVALID_RECIPIENT_EMAIL"
  | "ARCHIVE_NOT_AVAILABLE"
  | "PERSISTENCE_FAILED";

export type SendInvoiceEmailErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "STALE_VERSION"
  | "INVALID_INPUT"
  | "EMAIL_NOT_CONFIGURED"
  | "NO_RECIPIENT_EMAIL"
  | "INVALID_RECIPIENT_EMAIL"
  | "ALREADY_PENDING"
  | "UNKNOWN_ACKNOWLEDGEMENT_REQUIRED"
  | "INVALID_UNKNOWN_ACKNOWLEDGEMENT"
  | "ARCHIVE_NOT_AVAILABLE"
  | "ISSUE_FAILED"
  | "PERSISTENCE_FAILED";

export type SendInvoiceEmailResult =
  | { ok: true; outcome: "ACCEPTED" | "FAILED" | "UNKNOWN"; attemptId: string; invoiceFinalizedAt?: Date }
  | { ok: true; outcome: "ISSUED_EMAIL_NOT_SENT"; invoiceFinalizedAt: Date; emailError: PostIssueEmailFailureCode }
  | { ok: false; error: SendInvoiceEmailErrorCode };

export type SendInvoiceEmailDeps = {
  now: () => Date;
  generateAttemptId: () => string;
  issue: typeof issueInvoice;
  issueOverrides: Partial<IssueInvoiceDeps>;
  downloadPdf: typeof downloadInvoicePdfObject;
  sendEmail: typeof sendEmailViaResend;
  resolveOrigin: typeof resolveTrustedInvoiceEmailOrigin;
  checkReadiness: typeof checkEmailProviderReadiness;
};

const defaultDeps: SendInvoiceEmailDeps = {
  now: () => new Date(),
  generateAttemptId: () => randomUUID(),
  issue: issueInvoice,
  issueOverrides: {},
  downloadPdf: downloadInvoicePdfObject,
  sendEmail: sendEmailViaResend,
  resolveOrigin: resolveTrustedInvoiceEmailOrigin,
  checkReadiness: checkEmailProviderReadiness,
};

type AttemptState = { id: string; status: "PENDING" | "ACCEPTED" | "FAILED" | "UNKNOWN"; attemptedAt: Date };

function fail(error: SendInvoiceEmailErrorCode): SendInvoiceEmailResult {
  return { ok: false, error };
}

function postIssueFailure(finalizedAt: Date | undefined, error: PostIssueEmailFailureCode): SendInvoiceEmailResult {
  return finalizedAt ? { ok: true, outcome: "ISSUED_EMAIL_NOT_SENT", invoiceFinalizedAt: finalizedAt, emailError: error } : fail(error);
}

function existingOutcome(attempt: AttemptState, finalizedAt?: Date): SendInvoiceEmailResult {
  if (attempt.status === "PENDING") return fail("ALREADY_PENDING");
  return { ok: true, outcome: attempt.status, attemptId: attempt.id, ...(finalizedAt ? { invoiceFinalizedAt: finalizedAt } : {}) };
}

function isCanonicalIso(raw: string): boolean {
  const parsed = new Date(raw);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === raw;
}

function validateRecipient(raw: string | null): { ok: true; email: string } | { ok: false; error: "NO_RECIPIENT_EMAIL" | "INVALID_RECIPIENT_EMAIL" } {
  const email = raw?.trim() ?? "";
  if (!email) return { ok: false, error: "NO_RECIPIENT_EMAIL" };
  return EMAIL_PATTERN.test(email) ? { ok: true, email } : { ok: false, error: "INVALID_RECIPIENT_EMAIL" };
}

const invoiceSelect = {
  id: true,
  status: true,
  invoiceNumber: true,
  amount: true,
  currency: true,
  dueDate: true,
  finalizedAt: true,
  pdfStoragePath: true,
  pdfGeneratedAt: true,
  issuerSnapshot: true,
  recipientSnapshot: true,
  documentVersion: true,
  client: { select: { email: true, portalUsers: { take: 1, select: { id: true } } } },
} as const;

async function readInvoice(invoiceId: string, organizationId: string) {
  return prisma.invoice.findFirst({
    where: {
      id: invoiceId,
      organizationId,
      project: { organizationId },
      client: { organizationId },
    },
    select: invoiceSelect,
  });
}

async function readExactAttempt(invoiceId: string, idempotencyKey: string, organizationId: string): Promise<AttemptState | null> {
  return prisma.invoiceEmailAttempt.findFirst({
    where: { invoiceId, idempotencyKey, invoice: { organizationId } },
    select: { id: true, status: true, attemptedAt: true },
  });
}

async function readPendingAttempt(invoiceId: string, organizationId: string): Promise<AttemptState | null> {
  return prisma.invoiceEmailAttempt.findFirst({
    where: { invoiceId, status: "PENDING", invoice: { organizationId } },
    select: { id: true, status: true, attemptedAt: true },
  });
}

async function readLatestAttempt(invoiceId: string, organizationId: string): Promise<AttemptState | null> {
  return prisma.invoiceEmailAttempt.findFirst({
    where: { invoiceId, invoice: { organizationId } },
    orderBy: [{ attemptedAt: "desc" }, { id: "desc" }],
    select: { id: true, status: true, attemptedAt: true },
  });
}

async function settleAttempt(params: {
  attemptId: string;
  invoiceId: string;
  organizationId: string;
  desired: "ACCEPTED" | "FAILED" | "UNKNOWN";
  now: Date;
  providerMessageId?: string;
  failureReason?: string;
  finalizedAt?: Date;
}): Promise<SendInvoiceEmailResult> {
  const { attemptId, invoiceId, organizationId, desired, now, finalizedAt } = params;
  const data = {
    status: desired,
    providerMessageId: desired === "ACCEPTED" ? params.providerMessageId ?? null : null,
    providerAcceptedAt: desired === "ACCEPTED" ? now : null,
    failureReason: desired === "ACCEPTED" ? null : params.failureReason ?? null,
  } as const;

  try {
    const settled = await prisma.invoiceEmailAttempt.updateMany({
      where: { id: attemptId, invoiceId, status: "PENDING", invoice: { organizationId } },
      data,
    });
    if (settled.count === 1) {
      return { ok: true, outcome: desired, attemptId, ...(finalizedAt ? { invoiceFinalizedAt: finalizedAt } : {}) };
    }

    const actual = await prisma.invoiceEmailAttempt.findFirst({
      where: { id: attemptId, invoiceId, invoice: { organizationId } },
      select: { id: true, status: true, attemptedAt: true },
    });
    return actual && actual.status !== "PENDING"
      ? existingOutcome(actual, finalizedAt)
      : { ok: true, outcome: "UNKNOWN", attemptId, ...(finalizedAt ? { invoiceFinalizedAt: finalizedAt } : {}) };
  } catch {
    try {
      await prisma.invoiceEmailAttempt.updateMany({
        where: { id: attemptId, invoiceId, status: "PENDING", invoice: { organizationId } },
        data: { status: "UNKNOWN", providerMessageId: null, providerAcceptedAt: null, failureReason: "settlement_failed" },
      });
    } catch {
      // A later request's stale sweep is the durable recovery path.
    }
    return { ok: true, outcome: "UNKNOWN", attemptId, ...(finalizedAt ? { invoiceFinalizedAt: finalizedAt } : {}) };
  }
}

export async function sendInvoiceEmail(
  input: SendInvoiceEmailInput,
  overrides: Partial<SendInvoiceEmailDeps> = {},
): Promise<SendInvoiceEmailResult> {
  const deps = { ...defaultDeps, ...overrides };
  const { actor, invoiceId, idempotencyKey, acknowledgedStaleAttemptId } = input;

  try {
    assertCanAccessPaymentDetails(actor.role);
  } catch (error) {
    if (error instanceof OrganizationSetupAccessError) return fail("FORBIDDEN");
    throw error;
  }

  if (!UUID_PATTERN.test(invoiceId) || !UUID_V4_PATTERN.test(idempotencyKey)) return fail("INVALID_INPUT");
  if (acknowledgedStaleAttemptId !== undefined && !UUID_PATTERN.test(acknowledgedStaleAttemptId)) return fail("INVALID_INPUT");

  let invoice: Awaited<ReturnType<typeof readInvoice>>;
  try {
    invoice = await readInvoice(invoiceId, actor.organizationId);
  } catch {
    return fail("PERSISTENCE_FAILED");
  }
  if (!invoice) return fail("NOT_FOUND");
  if (invoice.status === "DRAFT" && (!input.expectedUpdatedAt || !isCanonicalIso(input.expectedUpdatedAt))) return fail("STALE_VERSION");
  if (deps.checkReadiness() !== "ready") return fail("EMAIL_NOT_CONFIGURED");
  const earlyRecipient = validateRecipient(invoice.client.email);
  if (!earlyRecipient.ok) return fail(earlyRecipient.error);

  let exactAttempt: AttemptState | null;
  let pendingAttempt: AttemptState | null;
  try {
    exactAttempt = await readExactAttempt(invoiceId, idempotencyKey, actor.organizationId);
    if (exactAttempt && exactAttempt.status !== "PENDING") return existingOutcome(exactAttempt);
    const now = deps.now();
    if (exactAttempt && now.getTime() - exactAttempt.attemptedAt.getTime() <= STALE_PENDING_THRESHOLD_MS) return fail("ALREADY_PENDING");

    pendingAttempt = await readPendingAttempt(invoiceId, actor.organizationId);
    if (pendingAttempt && now.getTime() - pendingAttempt.attemptedAt.getTime() > STALE_PENDING_THRESHOLD_MS) {
      await prisma.invoiceEmailAttempt.updateMany({
        where: {
          id: pendingAttempt.id,
          invoiceId,
          status: "PENDING",
          attemptedAt: { lt: new Date(now.getTime() - STALE_PENDING_THRESHOLD_MS) },
          invoice: { organizationId: actor.organizationId },
        },
        data: { status: "UNKNOWN", failureReason: "stale_no_settlement", providerMessageId: null, providerAcceptedAt: null },
      });
    }

    exactAttempt = await readExactAttempt(invoiceId, idempotencyKey, actor.organizationId);
    if (exactAttempt) return existingOutcome(exactAttempt);
    pendingAttempt = await readPendingAttempt(invoiceId, actor.organizationId);
    if (pendingAttempt) return fail("ALREADY_PENDING");
    const latest = await readLatestAttempt(invoiceId, actor.organizationId);
    if (latest?.status === "UNKNOWN") {
      if (!acknowledgedStaleAttemptId) return fail("UNKNOWN_ACKNOWLEDGEMENT_REQUIRED");
      if (acknowledgedStaleAttemptId !== latest.id) return fail("INVALID_UNKNOWN_ACKNOWLEDGEMENT");
    } else if (acknowledgedStaleAttemptId) {
      return fail("INVALID_UNKNOWN_ACKNOWLEDGEMENT");
    }
  } catch {
    return fail("PERSISTENCE_FAILED");
  }

  let finalizedAt: Date | undefined;
  if (invoice.status === "DRAFT") {
    const issued = await deps.issue(
      { actor, invoiceId, expectedUpdatedAt: input.expectedUpdatedAt! },
      deps.issueOverrides,
    );
    if (!issued.ok) {
      if (issued.error === "FORBIDDEN") return fail("FORBIDDEN");
      if (issued.error === "NOT_FOUND") return fail("NOT_FOUND");
      if (issued.error === "STALE_VERSION" || issued.error === "CONFLICT" || issued.error === "NOT_DRAFT") return fail("STALE_VERSION");
      return fail("ISSUE_FAILED");
    }
    finalizedAt = issued.finalizedAt;
  }

  try {
    invoice = await readInvoice(invoiceId, actor.organizationId);
  } catch {
    return postIssueFailure(finalizedAt, "PERSISTENCE_FAILED");
  }
  if (!invoice) return postIssueFailure(finalizedAt, "PERSISTENCE_FAILED");
  if (deps.checkReadiness() !== "ready") return postIssueFailure(finalizedAt, "EMAIL_NOT_CONFIGURED");
  const recipient = validateRecipient(invoice.client.email);
  if (!recipient.ok) return postIssueFailure(finalizedAt, recipient.error);

  if (classifyInvoiceArchival(invoice).kind !== "archived") return postIssueFailure(finalizedAt, "ARCHIVE_NOT_AVAILABLE");
  const issuer = parseIssuerSnapshot(invoice.issuerSnapshot);
  const frozenRecipient = parseRecipientSnapshot(invoice.recipientSnapshot);
  if (!issuer.ok || !frozenRecipient.ok) return postIssueFailure(finalizedAt, "ARCHIVE_NOT_AVAILABLE");

  let identity: InvoicePdfObjectIdentity;
  try {
    const ledger = await prisma.invoicePdfArchiveObject.findFirst({
      where: {
        organizationId: actor.organizationId,
        invoiceId,
        storagePath: invoice.pdfStoragePath!,
        documentVersion: invoice.documentVersion,
        status: "REFERENCED",
        referencedAt: { not: null },
      },
      select: { id: true, organizationId: true, invoiceId: true, documentVersion: true },
    });
    if (!ledger?.invoiceId) return postIssueFailure(finalizedAt, "ARCHIVE_NOT_AVAILABLE");
    identity = { organizationId: ledger.organizationId, invoiceId: ledger.invoiceId, documentVersion: ledger.documentVersion, archiveId: ledger.id };
    if (buildInvoicePdfStoragePath(identity) !== invoice.pdfStoragePath) return postIssueFailure(finalizedAt, "ARCHIVE_NOT_AVAILABLE");
  } catch {
    return postIssueFailure(finalizedAt, "ARCHIVE_NOT_AVAILABLE");
  }

  let pdf;
  try {
    pdf = await deps.downloadPdf({ identity });
  } catch {
    return postIssueFailure(finalizedAt, "ARCHIVE_NOT_AVAILABLE");
  }
  if (!pdf.ok) return postIssueFailure(finalizedAt, "ARCHIVE_NOT_AVAILABLE");

  const origin = deps.resolveOrigin();
  const portalInvoiceUrl = origin && invoice.client.portalUsers.length > 0 ? `${origin}/portal/invoices/${invoice.id}` : null;
  let content;
  try {
    content = buildInvoiceEmailContent({
      invoiceNumber: invoice.invoiceNumber,
      recipientDisplayName: frozenRecipient.snapshot.billingName,
      issuerDisplayName: issuer.snapshot.legalName,
      totalAmount: invoice.amount,
      currency: invoice.currency,
      dueDate: invoice.dueDate,
      portalInvoiceUrl,
    });
  } catch {
    return postIssueFailure(finalizedAt, "PERSISTENCE_FAILED");
  }

  const attemptId = deps.generateAttemptId();
  if (!UUID_PATTERN.test(attemptId)) return postIssueFailure(finalizedAt, "PERSISTENCE_FAILED");
  try {
    await prisma.invoiceEmailAttempt.create({
      data: { id: attemptId, invoiceId, recipientEmail: recipient.email, status: "PENDING", idempotencyKey, requestedByUserId: actor.userId },
    });
  } catch (error) {
    const conflict = mapInvoiceEmailAttemptWriteError(error);
    try {
      if (conflict === "IDEMPOTENCY_KEY_CONFLICT") {
        const existing = await readExactAttempt(invoiceId, idempotencyKey, actor.organizationId);
        if (existing) return existingOutcome(existing, finalizedAt);
      } else if (conflict === "ALREADY_PENDING_CONFLICT") {
        const pending = await readPendingAttempt(invoiceId, actor.organizationId);
        if (pending) return finalizedAt ? postIssueFailure(finalizedAt, "PERSISTENCE_FAILED") : fail("ALREADY_PENDING");
      }
    } catch {
      // Fall through to the bounded persistence result.
    }
    return postIssueFailure(finalizedAt, "PERSISTENCE_FAILED");
  }

  const from = process.env.INVITATION_FROM_EMAIL?.trim();
  if (!from) {
    return settleAttempt({ attemptId, invoiceId, organizationId: actor.organizationId, desired: "FAILED", now: deps.now(), failureReason: "not_configured", finalizedAt });
  }

  let providerResult: Awaited<ReturnType<typeof sendEmailViaResend>>;
  try {
    providerResult = await deps.sendEmail({
      to: recipient.email,
      from,
      subject: content.subject,
      html: content.html.replace("</body>", `${buildEmailLegalFooterHtml()}\n  </body>`),
      text: `${content.text}\n${buildEmailLegalFooterText()}`,
      attachments: [{ filename: buildInvoicePdfDownloadFilename(invoice.invoiceNumber), content: pdf.bytes.toString("base64"), content_type: pdf.contentType }],
      timeoutMs: PROVIDER_TIMEOUT_MS,
      idempotencyKey,
    });
  } catch {
    providerResult = { ok: false, reason: "network_error" };
  }

  if (providerResult.ok) {
    return settleAttempt({ attemptId, invoiceId, organizationId: actor.organizationId, desired: "ACCEPTED", now: deps.now(), providerMessageId: providerResult.messageId, finalizedAt });
  }
  if (providerResult.reason === "network_error") {
    return settleAttempt({ attemptId, invoiceId, organizationId: actor.organizationId, desired: "UNKNOWN", now: deps.now(), failureReason: "provider_outcome_unknown", finalizedAt });
  }
  return settleAttempt({ attemptId, invoiceId, organizationId: actor.organizationId, desired: "FAILED", now: deps.now(), failureReason: providerResult.reason, finalizedAt });
}
