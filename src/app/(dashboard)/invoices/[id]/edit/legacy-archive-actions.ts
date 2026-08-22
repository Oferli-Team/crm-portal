"use server";

import { revalidatePath } from "next/cache";
import { getCurrentMembership } from "@/lib/current-user";
import { assertCanAccessPaymentDetails, OrganizationSetupAccessError } from "@/lib/organization-setup/authorization";
import { archiveLegacyInvoice } from "@/lib/invoices/pdf/legacy-archive-invoice";
import type { LegacyArchiveErrorCode } from "@/lib/invoices/lifecycle";

/**
 * Invoice System Official Slice 3, Legacy Archive — the one dedicated
 * staff-triggered archival action for an already-non-DRAFT invoice whose
 * classification is exactly legacy_eligible. Mirrors issue-actions.ts's
 * own structure exactly.
 *
 * `invoiceId`/`expectedUpdatedAt` are the only two values this action ever
 * trusts from the browser. The actor (organizationId/userId/userName/role)
 * always comes from getCurrentMembership() — the real, server-resolved
 * session — never from a form field, and is independently re-checked for
 * OWNER access here (in addition to archiveLegacyInvoice()'s own re-check),
 * so neither layer relies on the other alone.
 *
 * PORTAL EXCLUSION: getCurrentMembership() calls getCurrentUserOrganization()
 * -> getOrCreateUser(), which redirects a Portal-only identity (a
 * PortalUser with no staff User row) to /portal before this action's own
 * body can even resolve an actor — a Portal-only session can never reach
 * the assertCanAccessPaymentDetails() check below, let alone
 * archiveLegacyInvoice() itself. This is the actual enforcement mechanism,
 * not this file's location under (dashboard).
 */
export type LegacyArchiveActionResult =
  | { ok: true; outcome: "ARCHIVED"; finalizedAt: Date }
  | { ok: true; outcome: "ALREADY_ARCHIVED"; finalizedAt: Date }
  | { ok: false; error: LegacyArchiveErrorCode };

function isCanonicalIso(raw: string): boolean {
  const date = new Date(raw);
  return !Number.isNaN(date.getTime()) && date.toISOString() === raw;
}

export async function archiveLegacyInvoiceAction(
  invoiceId: string,
  expectedUpdatedAt: string,
): Promise<LegacyArchiveActionResult> {
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

  const result = await archiveLegacyInvoice({
    actor: { organizationId, userId: user.id, userName: user.name, role: membership.role },
    invoiceId,
    expectedUpdatedAt,
  });

  if (result.ok) {
    revalidatePath(`/invoices/${invoiceId}/edit`);
    revalidatePath("/invoices");
    revalidatePath("/dashboard");
    return { ok: true, outcome: result.outcome, finalizedAt: result.finalizedAt };
  }

  return { ok: false, error: result.error };
}
