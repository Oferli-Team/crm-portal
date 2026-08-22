"use server";

import { revalidatePath } from "next/cache";
import { getCurrentMembership } from "@/lib/current-user";
import { assertCanAccessPaymentDetails, OrganizationSetupAccessError } from "@/lib/organization-setup/authorization";
import { checkRateLimit, INVOICE_EMAIL_SEND_LIMIT } from "@/lib/rate-limit";
import { sendInvoiceEmail, type SendInvoiceEmailErrorCode } from "@/lib/invoices/email/send-invoice-email";

export type SendInvoiceEmailActionResult =
  | {
      ok: true;
      outcome: "ACCEPTED" | "FAILED" | "UNKNOWN" | "ISSUED_EMAIL_NOT_SENT";
      attemptId?: string;
      invoiceFinalizedAt?: string;
      emailError?: string;
    }
  | { ok: false; error: SendInvoiceEmailErrorCode | "RATE_LIMITED" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isCanonicalIso(raw: string): boolean {
  const date = new Date(raw);
  return !Number.isNaN(date.getTime()) && date.toISOString() === raw;
}

export async function sendInvoiceEmailAction(
  invoiceId: string,
  idempotencyKey: string,
  expectedUpdatedAt?: string,
  acknowledgedStaleAttemptId?: string,
): Promise<SendInvoiceEmailActionResult> {
  const { user, organizationId, membership } = await getCurrentMembership();

  try {
    assertCanAccessPaymentDetails(membership.role);
  } catch (error) {
    if (error instanceof OrganizationSetupAccessError) return { ok: false, error: "FORBIDDEN" };
    throw error;
  }

  if (checkRateLimit(INVOICE_EMAIL_SEND_LIMIT, user.id).limited) return { ok: false, error: "RATE_LIMITED" };
  if (!UUID_PATTERN.test(invoiceId) || !UUID_V4_PATTERN.test(idempotencyKey)) return { ok: false, error: "INVALID_INPUT" };
  if (acknowledgedStaleAttemptId !== undefined && !UUID_PATTERN.test(acknowledgedStaleAttemptId)) {
    return { ok: false, error: "INVALID_INPUT" };
  }
  // Same defense-in-depth precedent as issueInvoiceAction's own
  // isCanonicalIso() check — the service re-validates this too, but
  // neither layer relies on the other alone.
  if (expectedUpdatedAt !== undefined && !isCanonicalIso(expectedUpdatedAt)) {
    return { ok: false, error: "STALE_VERSION" };
  }

  const result = await sendInvoiceEmail({
    actor: { organizationId, userId: user.id, userName: user.name, role: membership.role },
    invoiceId,
    idempotencyKey,
    expectedUpdatedAt,
    acknowledgedStaleAttemptId,
  });

  if (!result.ok) return result;

  revalidatePath(`/invoices/${invoiceId}/edit`);
  if (result.invoiceFinalizedAt) {
    revalidatePath("/invoices");
    revalidatePath("/dashboard");
  }

  return {
    ok: true,
    outcome: result.outcome,
    ...(result.outcome !== "ISSUED_EMAIL_NOT_SENT" ? { attemptId: result.attemptId } : {}),
    ...(result.invoiceFinalizedAt ? { invoiceFinalizedAt: result.invoiceFinalizedAt.toISOString() } : {}),
    ...(result.outcome === "ISSUED_EMAIL_NOT_SENT" ? { emailError: result.emailError } : {}),
  };
}
