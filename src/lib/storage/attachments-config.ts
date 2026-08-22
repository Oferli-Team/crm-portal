export const ATTACHMENTS_BUCKET = "attachments";

export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export const MAX_ATTACHMENTS_PER_ENTITY = 20;

export const SIGNED_URL_TTL_SECONDS = 60;

export type AllowedAttachmentType = {
  mimeType: string;
  /** Lowercase, no leading dot. */
  extensions: readonly string[];
};

/**
 * The complete allowlist — anything not listed here is rejected by
 * validateAttachmentFile(), including (not exhaustive, just the obvious
 * abuse cases): executables, shell/PowerShell scripts, JavaScript, HTML,
 * SVG (can carry embedded scripts), and archive formats (zip/rar/7z/tar) —
 * none of these ever appear below, on purpose, and none should be added
 * without deliberately re-opening this decision.
 */
export const ALLOWED_ATTACHMENT_TYPES: readonly AllowedAttachmentType[] = [
  { mimeType: "application/pdf", extensions: ["pdf"] },
  { mimeType: "image/png", extensions: ["png"] },
  { mimeType: "image/jpeg", extensions: ["jpg", "jpeg"] },
  { mimeType: "image/webp", extensions: ["webp"] },
  { mimeType: "text/plain", extensions: ["txt"] },
  { mimeType: "text/csv", extensions: ["csv"] },
  { mimeType: "application/msword", extensions: ["doc"] },
  {
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: ["docx"],
  },
  { mimeType: "application/vnd.ms-excel", extensions: ["xls"] },
  {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extensions: ["xlsx"],
  },
] as const;
