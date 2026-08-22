"use server";

import { revalidatePath } from "next/cache";
import { getCurrentMembership } from "@/lib/current-user";
import { assertCanAccessPaymentDetails, OrganizationSetupAccessError } from "@/lib/organization-setup/authorization";
import { issueInvoice } from "@/lib/invoices/pdf/issue-invoice";
import type { IssueInvoiceErrorCode } from "@/lib/invoices/lifecycle";

/**
 * Invoice System Official Slice 3, sub-PR 3b — the one dedicated live
 * DRAFT -> SENT Issue action. Never modifies updateInvoiceAction (the
 * ordinary create/edit action) to allow this transition — this is the
 * only path that can move an Invoice out of DRAFT via Issue.
 *
 * `invoiceId`/`expectedUpdatedAt` are the only two values this action ever
 * trusts from the browser. The actor (organizationId/userId/userName/role)
 * always comes from getCurrentMembership() — the real, server-resolved
 * session — never from a form field, and is independently re-checked for
 * OWNER access here (in addition to issueInvoice()'s own re-check), so
 * neither layer relies on the other alone.
 */
export type IssueInvoiceActionResult =
  | { ok: true; finalizedAt: Date }
  | { ok: false; error: IssueInvoiceErrorCode };

function isCanonicalIso(raw: string): boolean {
  const date = new Date(raw);
  return !Number.isNaN(date.getTime()) && date.toISOString() === raw;
}

export async function issueInvoiceAction(
  invoiceId: string,
  expectedUpdatedAt: string,
): Promise<IssueInvoiceActionResult> {
  const { user, organizationId, membership } = await getCurrentMembership();

  try {
    assertCanAccessPaymentDetails(membership.role);
  } catch (err) {
    if (err instanceof OrganizationSetupAccessError) return { ok: false, error: "FORBIDDEN" };
    throw err;
  }

  if (typeof invoiceId !== "string" || invoiceId.length === 0) {
    return { ok: false, error: "NOT_FOUND" };
  }
  if (typeof expectedUpdatedAt !== "string" || !isCanonicalIso(expectedUpdatedAt)) {
    return { ok: false, error: "STALE_VERSION" };
  }

  const result = await issueInvoice({
    actor: { organizationId, userId: user.id, userName: user.name, role: membership.role },
    invoiceId,
    expectedUpdatedAt,
  });

  if (result.ok) {
    revalidatePath(`/invoices/${invoiceId}/edit`);
    revalidatePath("/invoices");
    revalidatePath("/dashboard");
    return { ok: true, finalizedAt: result.finalizedAt };
  }

  return { ok: false, error: result.error };
}
