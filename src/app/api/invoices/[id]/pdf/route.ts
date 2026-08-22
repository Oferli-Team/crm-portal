import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { checkRateLimit, INVOICE_PDF_DOWNLOAD_LIMIT } from "@/lib/rate-limit";
import { classifyInvoiceArchival } from "@/lib/invoices/pdf/classify-archival";
import { buildInvoicePdfStoragePath, createInvoicePdfSignedUrl, type InvoicePdfObjectIdentity } from "@/lib/invoices/pdf/storage";

const NOT_FOUND_MESSAGE = "Not found";
const SIGNING_FAILURE_MESSAGE = "Unable to generate a download link.";

/**
 * Invoice System Official Slice 3, sub-PR 3c — staff signed PDF
 * download/view. Mirrors src/app/api/attachments/[id]/download/route.ts's
 * own structure exactly (auth -> rate limit -> scoped fetch -> sign ->
 * redirect), with two Invoice-specific additions: classifyInvoiceArchival()
 * as the single gate for which invoices are ever eligible, and a
 * ledger-consistency proof (query + canonical path rebuild) before a
 * signed URL is ever requested. Strictly read-only — no Invoice,
 * InvoicePdfArchiveObject, Storage, Activity, or Notification write on
 * any branch, for any outcome.
 *
 * draft / legacy_eligible / invariant_violation (any reason) / nonexistent
 * / cross-org all collapse to the identical generic 404 body — never
 * revealing which condition failed. An archived Invoice whose ledger
 * cannot be proven consistent (missing REFERENCED row, or a returned row
 * whose identity does not reproduce the persisted path) collapses to the
 * identical generic 502 body used for a genuine Storage/signing failure —
 * again never revealing which check failed.
 */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/invoices/[id]/pdf">,
) {
  const { id } = await ctx.params;

  // 1. getCurrentUserOrganization() only ever resolves an organizationId
  // backed by an existing Membership for the current user — a foreign
  // org's invoice id simply won't match the scoped lookup below,
  // indistinguishable from a nonexistent one. No role gate: every staff
  // Membership role may download.
  const { user, organizationId } = await getCurrentUserOrganization();

  // 2-3. Dedicated rate limiter, isolated from ATTACHMENT_DOWNLOAD_LIMIT,
  // checked before any Invoice-domain or ledger query.
  const limitCheck = checkRateLimit(INVOICE_PDF_DOWNLOAD_LIMIT, user.id);
  if (limitCheck.limited) {
    return new NextResponse(limitCheck.message, { status: 429 });
  }

  // 4. Organization-scoped fetch, project.organizationId as defense in
  // depth — select only the scalar fields classifyInvoiceArchival() and
  // the ledger-consistency proof below actually need.
  const invoice = await prisma.invoice.findFirst({
    where: { id, organizationId, project: { organizationId } },
    select: {
      id: true,
      invoiceNumber: true,
      status: true,
      finalizedAt: true,
      pdfStoragePath: true,
      pdfGeneratedAt: true,
      issuerSnapshot: true,
      recipientSnapshot: true,
      documentVersion: true,
    },
  });

  if (!invoice) {
    return new NextResponse(NOT_FOUND_MESSAGE, { status: 404 });
  }

  // 6. The single canonical classifier call for this route.
  const classification = classifyInvoiceArchival(invoice);

  // 5. draft / legacy_eligible / invariant_violation (any reason) — same
  // generic 404 as nonexistent/cross-org above.
  if (classification.kind !== "archived") {
    return new NextResponse(NOT_FOUND_MESSAGE, { status: 404 });
  }

  // 7. All six predicates in the WHERE clause — a row is only ever
  // returned if it matches every one simultaneously.
  const ledger = await prisma.invoicePdfArchiveObject.findFirst({
    where: {
      organizationId,
      invoiceId: invoice.id,
      storagePath: invoice.pdfStoragePath!,
      documentVersion: invoice.documentVersion,
      status: "REFERENCED",
      referencedAt: { not: null },
    },
    select: { id: true, organizationId: true, invoiceId: true, documentVersion: true },
  });

  // 8. No row satisfies all six predicates — fail closed, never call the
  // signing helper.
  if (!ledger) {
    return new NextResponse(SIGNING_FAILURE_MESSAGE, { status: 502 });
  }

  // 9. The WHERE clause above already guarantees invoiceId matched
  // invoice.id (so it cannot be null in practice), but the Prisma field
  // is nullable by schema — handle that explicitly and fail closed rather
  // than asserting past it.
  if (!ledger.invoiceId) {
    return new NextResponse(SIGNING_FAILURE_MESSAGE, { status: 502 });
  }

  const identity: InvoicePdfObjectIdentity = {
    organizationId: ledger.organizationId,
    invoiceId: ledger.invoiceId,
    documentVersion: ledger.documentVersion,
    archiveId: ledger.id,
  };

  // 10. Rebuild the canonical path from the ledger's own identity fields
  // and require it to reproduce the persisted path exactly. A thrown
  // rebuild (a malformed persisted identity) and a mismatched path both
  // fail closed identically — neither ever reaches the signing helper.
  let rebuiltPath: string;
  try {
    rebuiltPath = buildInvoicePdfStoragePath(identity);
  } catch {
    return new NextResponse(SIGNING_FAILURE_MESSAGE, { status: 502 });
  }
  if (rebuiltPath !== invoice.pdfStoragePath) {
    return new NextResponse(SIGNING_FAILURE_MESSAGE, { status: 502 });
  }

  // 11. Only now — every database and canonical-identity check has
  // succeeded — is the signing helper ever called.
  const signed = await createInvoicePdfSignedUrl({ identity, invoiceNumber: invoice.invoiceNumber });

  // 12. Signing failure — same generic 502.
  if (!signed.ok) {
    return new NextResponse(SIGNING_FAILURE_MESSAGE, { status: 502 });
  }

  // 13. No PDF bytes proxied through Next.js, no Content-Type:
  // application/pdf claimed by this route's own 307 response — that
  // belongs to the stored object's own metadata and/or Supabase's signed-
  // URL response once the client follows the redirect. Cache-Control is
  // set explicitly (unlike the sibling attachment route) per this route's
  // own approved design.
  const response = NextResponse.redirect(signed.url, 307);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
