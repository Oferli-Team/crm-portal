import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPortalUser } from "@/lib/current-portal-user";
import { checkRateLimit, PORTAL_INVOICE_PDF_DOWNLOAD_LIMIT } from "@/lib/rate-limit";
import { classifyInvoiceArchival } from "@/lib/invoices/pdf/classify-archival";
import { buildInvoicePdfStoragePath, createInvoicePdfSignedUrl, type InvoicePdfObjectIdentity } from "@/lib/invoices/pdf/storage";

const NOT_FOUND_MESSAGE = "Not found";
const SIGNING_FAILURE_MESSAGE = "Unable to generate a download link.";

/**
 * Invoice System Official Slice 3 — Portal Invoice PDF access. Separate
 * from src/app/api/invoices/[id]/pdf/route.ts (staff) on purpose, the
 * same reason the Portal attachment download route is kept apart from
 * its staff sibling: a portal identity's trust boundary is Client-level,
 * not organization-level, so sharing one route would mean either
 * weakening the staff check or bolting a portal-only branch onto it.
 * Mirrors that staff route's own structure exactly (auth -> rate limit ->
 * scoped fetch -> classify -> ledger proof -> sign -> redirect), with
 * getCurrentPortalUser()/the four-predicate Portal scoping contract
 * substituted for the staff identity/organization-scoped lookup.
 * Strictly read-only — no Invoice, InvoicePdfArchiveObject,
 * PortalDownloadRequest, Storage, Activity, or Notification write on any
 * branch, for any outcome. Deliberately does not call
 * recordPortalDownloadRequest() — see this route's own PR description for
 * why the existing Portal Analytics download metric stays attachment-only
 * in this sub-PR.
 *
 * nonexistent / cross-organization / same-organization-different-Client /
 * draft / legacy_eligible / invariant_violation (any reason) all collapse
 * to the identical generic 404 body — never revealing which condition
 * failed. An archived Invoice whose ledger cannot be proven consistent
 * (missing REFERENCED row, or a returned row whose identity does not
 * reproduce the persisted path) collapses to the identical generic 502
 * body used for a genuine Storage/signing failure — again never revealing
 * which check failed.
 */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/portal/invoices/[id]/pdf">,
) {
  const { id } = await ctx.params;

  // 1. getCurrentPortalUser() redirects to /portal/login for no session,
  // a staff-only identity, or a removed/nonexistent PortalUser — none of
  // those ever reach the lookup below. clientId/organizationId here are
  // never accepted from a route param, query string, header, form field,
  // or the staff-only active-organization cookie — both are always
  // derived from the verified PortalUser -> Client relation.
  const { portalUser, clientId, organizationId } = await getCurrentPortalUser();

  // 2-3. Dedicated rate limiter, isolated from every other download
  // limiter, checked before any Invoice-domain or ledger query.
  const limitCheck = checkRateLimit(PORTAL_INVOICE_PDF_DOWNLOAD_LIMIT, portalUser.id);
  if (limitCheck.limited) {
    return new NextResponse(limitCheck.message, { status: 429 });
  }

  // 4. The exact established Portal Invoice authorization contract
  // (matching getPortalInvoice()/verifyPortalAttachmentAccess()'s own
  // INVOICE case): clientId is the primary boundary, organizationId is
  // defense in depth, project.clientId guards against Invoice/Project
  // relation drift. Deliberately not project.organizationId — that
  // column is nullable (Project.organizationId: String?), and adding it
  // as a mandatory predicate could reject a legitimate Invoice whose
  // Project has a null organizationId even though Invoice.organizationId
  // itself is correct.
  const invoice = await prisma.invoice.findFirst({
    where: { id, clientId, organizationId, project: { clientId } },
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
  // generic 404 as nonexistent/cross-scope above. This route never fixes
  // general Portal DRAFT visibility (a DRAFT invoice may still appear in
  // the Portal list/detail today, per docs/invoicing-architecture.md §10,
  // deferred to Slice 5) — it only ever ensures DRAFT never receives a
  // PDF link or signed URL.
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
  // succeeded — is the signing helper ever called. Reused unchanged from
  // the staff route; no bucket/TTL/filename/TEST_MODE logic is
  // duplicated here.
  const signed = await createInvoicePdfSignedUrl({ identity, invoiceNumber: invoice.invoiceNumber });

  // 12. Signing failure — same generic 502.
  if (!signed.ok) {
    return new NextResponse(SIGNING_FAILURE_MESSAGE, { status: 502 });
  }

  // 13. No PDF bytes proxied through Next.js, no Content-Type:
  // application/pdf claimed by this route's own 307 response. No
  // PortalDownloadRequest write — this route is strictly read-only.
  const response = NextResponse.redirect(signed.url, 307);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
