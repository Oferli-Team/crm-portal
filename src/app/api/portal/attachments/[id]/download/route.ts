import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPortalUser } from "@/lib/current-portal-user";
import { verifyPortalAttachmentAccess } from "@/lib/client-portal/attachments";
import { createAttachmentSignedUrl } from "@/lib/storage/attachments-storage";
import { SIGNED_URL_TTL_SECONDS } from "@/lib/storage/attachments-config";
import { checkRateLimit, PORTAL_ATTACHMENT_DOWNLOAD_LIMIT } from "@/lib/rate-limit";
import { recordPortalDownloadRequest } from "@/lib/client-portal/analytics-events";

/**
 * Separate from /api/attachments/[id]/download (staff) on purpose — that
 * route scopes by organizationId alone, which isn't a fine-grained enough
 * boundary for a portal identity (an org has many Clients; a portal
 * contact may only ever reach files belonging to their own one). Sharing
 * one route would mean either weakening the staff check or bolting a
 * portal-only branch onto it — kept apart instead so neither trust
 * boundary's code can affect the other by accident.
 */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/portal/attachments/[id]/download">,
) {
  const { id } = await ctx.params;

  // getCurrentPortalUser() redirects to /portal/login for no session, a
  // staff-only identity, or a removed/nonexistent PortalUser — none of
  // those ever reach the lookup below, and clientId/organizationId here
  // are never accepted from a query param or cookie.
  const { portalUser, clientId, organizationId } = await getCurrentPortalUser();

  const limitCheck = checkRateLimit(PORTAL_ATTACHMENT_DOWNLOAD_LIMIT, portalUser.id);
  if (limitCheck.limited) {
    return new NextResponse(limitCheck.message, { status: 429 });
  }

  // Found by id alone — the id is not itself a trust boundary, which is
  // exactly why verifyPortalAttachmentAccess() re-derives ownership from
  // entityType/entityId/organizationId below rather than trusting this row.
  const attachment = await prisma.attachment.findFirst({
    where: { id },
    select: {
      entityType: true,
      entityId: true,
      organizationId: true,
      storageBucket: true,
      storagePath: true,
    },
  });

  if (!attachment) {
    return new NextResponse("Not found", { status: 404 });
  }

  const allowed = await verifyPortalAttachmentAccess(attachment, { clientId, organizationId });
  if (!allowed) {
    return new NextResponse("Not found", { status: 404 });
  }

  const signed = await createAttachmentSignedUrl({
    bucket: attachment.storageBucket,
    path: attachment.storagePath,
    expiresInSeconds: SIGNED_URL_TTL_SECONDS,
  });

  if (!signed.ok) {
    return new NextResponse("Unable to generate a download link.", { status: 502 });
  }

  // Portal Analytics persistence foundation (docs/analytics-architecture.md
  // §12, Slice 1). Recorded only now — after session/PortalUser
  // verification, the rate limit, the Attachment lookup, access
  // verification, and a successfully issued signed URL have all already
  // succeeded — meaning this row means exactly "an authorized request
  // received a signed download link," never an unauthorized attempt and
  // never a claim that the file was actually received. Best-effort:
  // recordPortalDownloadRequest() never throws, so a transient DB failure
  // here can never block the real redirect.
  await recordPortalDownloadRequest(prisma, organizationId);

  // 307 preserves the GET method on redirect and is never cached — the
  // signed URL is single-use-window (60s TTL), so it must be re-issued on
  // every request rather than reused. Never proxy/stream the file through
  // this route, and never log the signed URL, storagePath, or bucket.
  return NextResponse.redirect(signed.url, 307);
}
