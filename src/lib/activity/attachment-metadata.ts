export type AttachmentActivityMetadata = {
  fileName: string;
  parentEntityType: string;
  parentEntityLabel: string;
  actorName: string;
};

/**
 * Shared shape for FILE_UPLOADED and FILE_DELETED. Deliberately never
 * includes storagePath, signedUrl, mimeType, or bucket — those are Storage
 * infrastructure details, not audit-log-safe display data. fileName is the
 * sanitized display name (see sanitizeAttachmentFileName), not a raw
 * client-supplied string. parentEntityType/parentEntityLabel let this event
 * stay readable ("uploaded X to client Y") even after the Attachment row
 * itself — and possibly its parent — no longer exists, since Activity rows
 * are never updated once written.
 */
export function buildAttachmentActivityMetadata(
  fileName: string,
  parentEntityType: string,
  parentEntityLabel: string,
  actorName: string,
): AttachmentActivityMetadata {
  return { fileName, parentEntityType, parentEntityLabel, actorName };
}
