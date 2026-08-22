import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { validateLogoFile, buildLogoStoragePath } from "@/lib/storage/logo-files";
import { uploadLogoObject, removeLogoObject } from "@/lib/storage/logo-storage";
import { checkRateLimit, LOGO_UPLOAD_LIMIT } from "@/lib/rate-limit";
import type { LogoUploadState } from "@/types";

const VALIDATION_ERROR_MESSAGES: Record<string, string> = {
  empty_file: "The selected file is empty.",
  file_too_large: "This file is too large. Maximum size is 2 MB.",
  type_not_allowed: "Only PNG, JPEG, and WebP images are supported.",
  extension_mismatch: "The file extension doesn't match its detected type.",
};

/**
 * Sale-Ready Phase A.1 (Business Identity), PR4. OWNER-only — the caller
 * (the Server Action) must call canManageCompanyProfile()/
 * assertCanManageCompanyProfile() first, the same "authorization happens at
 * the call site" shape upsertCompanyProfile() itself already follows.
 *
 * Requires an OrganizationProfile row to already exist. Deliberately never
 * creates one: legalName/country/currency/timezone are all required
 * (non-null) columns on that row, so a logo-triggered create would have to
 * write placeholder values into fields that are otherwise only ever set
 * together, as a deliberate whole, via the Business Identity text form
 * (see upsertCompanyProfile). An OWNER who uploads a logo before ever
 * saving that form gets a clear, actionable error instead.
 */
export async function uploadOrganizationLogo({
  organizationId,
  actorId,
  formData,
}: {
  organizationId: string;
  actorId: string;
  formData: FormData;
}): Promise<LogoUploadState> {
  const limitCheck = checkRateLimit(LOGO_UPLOAD_LIMIT, actorId);
  if (limitCheck.limited) {
    return { error: limitCheck.message };
  }

  const profile = await prisma.organizationProfile.findUnique({
    where: { organizationId },
    select: { logoUrl: true },
  });
  if (!profile) {
    return { error: "Save your business details before uploading a logo." };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Please choose a file to upload." };
  }

  const validation = validateLogoFile({ name: file.name, type: file.type, size: file.size });
  if (!validation.valid) {
    return { error: VALIDATION_ERROR_MESSAGES[validation.error] };
  }

  const storagePath = buildLogoStoragePath({
    organizationId,
    uuid: randomUUID(),
    extension: validation.extension,
  });

  const uploadResult = await uploadLogoObject({
    path: storagePath,
    body: file,
    contentType: validation.mimeType,
  });
  if (!uploadResult.ok) {
    return { error: "Failed to upload the logo. Please try again." };
  }

  const previousLogoUrl = profile.logoUrl;

  try {
    await prisma.organizationProfile.update({
      where: { organizationId },
      data: { logoUrl: uploadResult.publicUrl },
    });
  } catch {
    // Compensate for the already-uploaded object — the DB write is what
    // failed here, not the upload, the same reasoning
    // uploadAttachmentForEntity's own compensation path already follows.
    await removeLogoObject({ publicUrl: uploadResult.publicUrl });
    return { error: "Failed to save the uploaded logo. Please try again." };
  }

  // Best-effort cleanup of the previous logo object, deliberately after
  // the DB write has already committed: a Storage failure here must never
  // fail this request, and must never roll back a logoUrl change that has
  // already succeeded. A leftover Storage object is an invisible orphan.
  if (previousLogoUrl) {
    await removeLogoObject({ publicUrl: previousLogoUrl });
  }

  return { error: null };
}
