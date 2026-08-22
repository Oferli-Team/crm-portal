import { ALLOWED_LOGO_TYPES, MAX_LOGO_SIZE_BYTES } from "./logo-config";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LogoFileInput = {
  name: string;
  type: string;
  size: number;
};

export type LogoValidationError = "empty_file" | "file_too_large" | "type_not_allowed" | "extension_mismatch";

export type LogoValidationResult =
  | { valid: true; mimeType: string; extension: string }
  | { valid: false; error: LogoValidationError };

function extractExtension(name: string): string | null {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) return null;
  return name.slice(dotIndex + 1).toLowerCase();
}

/**
 * Same (MIME, extension) cross-check as validateAttachmentFile — neither is
 * ever trusted alone. Duplicated here rather than shared/parameterized:
 * this module's allowlist and size ceiling are a deliberately different,
 * narrower policy (see logo-config.ts), and this codebase's own convention
 * is that small, self-contained validation modules stay independent (e.g.
 * validation/company-profile.ts's own duplicated EMAIL_PATTERN) rather than
 * generalized behind a shared parameterized validator.
 */
export function validateLogoFile(file: LogoFileInput): LogoValidationResult {
  if (!file.size || file.size <= 0) {
    return { valid: false, error: "empty_file" };
  }
  if (file.size > MAX_LOGO_SIZE_BYTES) {
    return { valid: false, error: "file_too_large" };
  }

  const allowed = ALLOWED_LOGO_TYPES.find((candidate) => candidate.mimeType === file.type);
  if (!allowed) {
    return { valid: false, error: "type_not_allowed" };
  }

  const extension = extractExtension(file.name);
  if (!extension || !allowed.extensions.includes(extension)) {
    return { valid: false, error: "extension_mismatch" };
  }

  return { valid: true, mimeType: allowed.mimeType, extension };
}

function assertServerUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`buildLogoStoragePath: ${label} must be a server-generated UUID.`);
  }
}

/**
 * organizations/{organizationId}/logo/{uuid}.{extension} — both ids must
 * already be server-generated UUIDs (this throws otherwise, catching a
 * future caller mistake before it ever reaches Storage); the client's own
 * filename is never consulted here at all, only the extension
 * validateLogoFile() already confirmed matches the detected MIME type.
 */
export function buildLogoStoragePath({
  organizationId,
  uuid,
  extension,
}: {
  organizationId: string;
  uuid: string;
  extension: string;
}): string {
  assertServerUuid(organizationId, "organizationId");
  assertServerUuid(uuid, "uuid");

  return `organizations/${organizationId}/logo/${uuid}.${extension}`;
}

/**
 * Recovers the Storage object path from a public URL previously returned by
 * Supabase's own getPublicUrl() — used only to best-effort remove the
 * *previous* logo object after a new upload succeeds (see
 * uploadOrganizationLogo). Supabase's public URL shape is a documented,
 * stable contract: `{projectUrl}/storage/v1/object/public/{bucket}/{path}`.
 * A pure string match, never a network call — returns null (never throws)
 * for anything that doesn't match, so a manually-edited or foreign-shaped
 * URL is simply skipped rather than mis-parsed into deleting the wrong
 * object.
 */
export function extractLogoStoragePathFromPublicUrl({
  publicUrl,
  supabaseUrl,
  bucket,
}: {
  publicUrl: string;
  supabaseUrl: string;
  bucket: string;
}): string | null {
  const prefix = `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/${bucket}/`;
  if (!publicUrl.startsWith(prefix)) return null;

  const path = publicUrl.slice(prefix.length);
  if (path.length === 0) return null;

  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}
