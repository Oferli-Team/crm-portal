import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { createAttachmentSignedUrl } from "@/lib/storage/attachments-storage";
import { SIGNED_URL_TTL_SECONDS } from "@/lib/storage/attachments-config";
import { checkRateLimit, ATTACHMENT_DOWNLOAD_LIMIT } from "@/lib/rate-limit";

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/attachments/[id]/download">,
) {
  const { id } = await ctx.params;

  // getCurrentUserOrganization() only ever resolves an organizationId
  // backed by an existing Membership for the current user (see
  // resolveActiveOrganizationId in lib/current-user.ts), so this is the
  // Membership check — a foreign org's attachment id simply won't match
  // the lookup below, indistinguishable from a nonexistent one.
  const { user, organizationId } = await getCurrentUserOrganization();

  const limitCheck = checkRateLimit(ATTACHMENT_DOWNLOAD_LIMIT, user.id);
  if (limitCheck.limited) {
    return new NextResponse(limitCheck.message, { status: 429 });
  }

  const attachment = await prisma.attachment.findFirst({
    where: { id, organizationId },
    select: { storageBucket: true, storagePath: true },
  });

  if (!attachment) {
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

  // 307 preserves the GET method on redirect and never caches — the signed
  // URL is single-use-window (60s TTL), so it must be re-issued every time.
  return NextResponse.redirect(signed.url, 307);
}
