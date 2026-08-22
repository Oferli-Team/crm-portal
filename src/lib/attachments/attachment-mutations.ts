import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { createActivity } from "@/lib/activity/create-activity";
import { buildAttachmentActivityMetadata } from "@/lib/activity/attachment-metadata";
import {
  sanitizeAttachmentFileName,
  validateAttachmentFile,
  buildAttachmentStoragePath,
} from "@/lib/storage/attachment-files";
import { uploadAttachmentObject, removeAttachmentObject } from "@/lib/storage/attachments-storage";
import { ATTACHMENTS_BUCKET, MAX_ATTACHMENTS_PER_ENTITY } from "@/lib/storage/attachments-config";
import { checkRateLimit, ATTACHMENT_UPLOAD_LIMIT } from "@/lib/rate-limit";
import { assertCanUploadAttachment, BillingLimitError } from "@/lib/billing/enforcement";
import type { AttachmentEntityType } from "@/generated/prisma/enums";
import type { AttachmentUploadState } from "@/types";

const VALIDATION_ERROR_MESSAGES: Record<string, string> = {
  empty_file: "The selected file is empty.",
  file_too_large: "This file is too large. Maximum size is 10 MB.",
  type_not_allowed: "This file type is not supported.",
  extension_mismatch: "The file extension doesn't match its detected type.",
};

/**
 * Entity-agnostic core of the attachment upload flow, extracted from the
 * original Client-only implementation (Stage 4) so Project (and any future
 * entity) can reuse it verbatim: count limit, file extraction, validation,
 * sanitization, Storage upload, then the Attachment + FILE_UPLOADED
 * transaction, with best-effort Storage compensation if the transaction
 * fails. Callers are responsible for resolving and authorizing the parent
 * entity (Client/Project/...) themselves before calling this, and for
 * revalidating their own page path afterwards on success.
 */
export async function uploadAttachmentForEntity({
  organizationId,
  actorId,
  actorName,
  entityType,
  entityId,
  parentEntityLabel,
  formData,
}: {
  organizationId: string;
  actorId: string;
  actorName: string;
  entityType: AttachmentEntityType;
  entityId: string;
  parentEntityLabel: string;
  formData: FormData;
}): Promise<AttachmentUploadState> {
  const limitCheck = checkRateLimit(ATTACHMENT_UPLOAD_LIMIT, actorId);
  if (limitCheck.limited) {
    return { error: limitCheck.message };
  }

  const existingCount = await prisma.attachment.count({
    where: { organizationId, entityType, entityId },
  });
  if (existingCount >= MAX_ATTACHMENTS_PER_ENTITY) {
    return {
      error: `This ${entityType.toLowerCase()} already has the maximum of ${MAX_ATTACHMENTS_PER_ENTITY} attachments.`,
    };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Please choose a file to upload." };
  }

  const validation = validateAttachmentFile({
    name: file.name,
    type: file.type,
    size: file.size,
  });
  if (!validation.valid) {
    return { error: VALIDATION_ERROR_MESSAGES[validation.error] };
  }

  // Billing & Subscriptions Stage 2 — checked before the Storage upload
  // (never after) so a rejected upload never wastes a real Storage write.
  // Deliberately a plain read here, not inside a transaction: this
  // function's own pre-existing per-entity count check just above already
  // follows the same "read now, upload happens outside any transaction
  // anyway" shape (Storage isn't transactional with Postgres), so this
  // adds no new residual race beyond what already exists — see
  // assertCanUploadAttachment's own doc comment for the exact trade-off.
  try {
    await assertCanUploadAttachment(organizationId, file.size);
  } catch (err) {
    if (err instanceof BillingLimitError) {
      return { error: err.message };
    }
    throw err;
  }

  // The sanitized name is used everywhere from here on — as the stored
  // display name, in the Storage path, and in Activity metadata — so there
  // is never a second, untrusted copy of the raw filename persisted anywhere.
  const safeFileName = sanitizeAttachmentFileName(file.name);
  const attachmentId = randomUUID();
  const storagePath = buildAttachmentStoragePath({
    organizationId,
    entityType,
    entityId,
    attachmentId,
    safeFileName,
  });

  const uploadResult = await uploadAttachmentObject({
    path: storagePath,
    body: file,
    contentType: validation.mimeType,
  });
  if (!uploadResult.ok) {
    return { error: "Failed to upload the file. Please try again." };
  }

  try {
    // Attachment row and its Activity entry are one atomic unit — a failed
    // Activity insert rolls the Attachment create back too.
    await prisma.$transaction(async (tx) => {
      await tx.attachment.create({
        data: {
          id: attachmentId,
          organizationId,
          uploadedById: actorId,
          entityType,
          entityId,
          storageBucket: ATTACHMENTS_BUCKET,
          storagePath,
          originalName: safeFileName,
          mimeType: validation.mimeType,
          sizeBytes: file.size,
        },
      });

      await createActivity(tx, {
        organizationId,
        actorId,
        entityType: "ATTACHMENT",
        entityId: attachmentId,
        action: "FILE_UPLOADED",
        metadata: buildAttachmentActivityMetadata(safeFileName, entityType, parentEntityLabel, actorName),
      });
    });
  } catch {
    // Compensate for the already-uploaded object — best-effort, since the
    // DB transaction is what failed, not this cleanup. An orphaned Storage
    // object is invisible and harmless; leaving it is strictly safer than
    // retrying the DB write here.
    await removeAttachmentObject({ path: storagePath });
    return { error: "Failed to save the uploaded file. Please try again." };
  }

  return { error: null };
}

/**
 * Entity-agnostic core of the attachment delete flow. `resolveParentLabel`
 * lets each caller resolve its own parent entity's display name (e.g. the
 * Client's or Project's name) for the FILE_DELETED Activity snapshot,
 * scoped however that caller sees fit — this module never assumes which
 * Prisma model entityId points at.
 */
export async function deleteAttachmentForEntity({
  organizationId,
  actorId,
  actorName,
  attachmentId,
  entityType,
  resolveParentLabel,
}: {
  organizationId: string;
  actorId: string;
  actorName: string;
  attachmentId: string;
  entityType: AttachmentEntityType;
  resolveParentLabel: (entityId: string) => Promise<string | null>;
}): Promise<void> {
  const attachment = await prisma.attachment.findFirst({
    where: { id: attachmentId, organizationId, entityType },
  });
  if (!attachment) {
    return;
  }

  // Snapshot taken before deletion, same reasoning as deleteClientAction —
  // Activity.entityId is not a foreign key, so this is what keeps the
  // entry readable once the Attachment row itself is gone.
  const parentLabel = (await resolveParentLabel(attachment.entityId)) ?? `Unknown ${entityType.toLowerCase()}`;

  await prisma.$transaction(async (tx) => {
    const result = await tx.attachment.deleteMany({
      where: { id: attachmentId, organizationId, entityType },
    });
    if (result.count === 0) {
      return;
    }

    await createActivity(tx, {
      organizationId,
      actorId,
      entityType: "ATTACHMENT",
      entityId: attachment.id,
      action: "FILE_DELETED",
      metadata: buildAttachmentActivityMetadata(attachment.originalName, entityType, parentLabel, actorName),
    });
  });

  // Best-effort, and deliberately after the transaction has already
  // committed — a Storage failure here must never roll back the DB delete.
  // A leftover Storage object is an invisible orphan; a DB row pointing at
  // a Storage object we failed to remove would still be gone from the UI
  // either way, so there is nothing left to keep consistent here.
  await removeAttachmentObject({ path: attachment.storagePath });
}

export type AttachmentParentCleanupTarget = {
  entityType: AttachmentEntityType;
  entityId: string;
  parentEntityLabel: string;
};

/**
 * Deletes every Attachment row for one or more parent targets — e.g. a
 * Client plus every Project that will be cascade-deleted alongside it,
 * since Postgres removes those Projects silently at the SQL level with no
 * further application code running for them. Must be called from inside
 * the caller's own transaction, alongside the parent mutation itself, so a
 * failure anywhere rolls everything back together.
 *
 * Deletes row-by-row (not one blanket deleteMany) and only writes
 * FILE_DELETED when that specific delete actually affected a row: if a
 * concurrent operation (e.g. someone deleting this one attachment through
 * the individual delete flow) already removed it, this silently skips it
 * rather than logging a second FILE_DELETED for the same file.
 *
 * Never touches Storage — only returns the storagePaths of everything it
 * removed, for the caller to best-effort clean up after its transaction
 * commits (see cleanupAttachmentStorageObjects).
 */
export async function deleteAttachmentsForParent(
  tx: Prisma.TransactionClient,
  {
    organizationId,
    actorId,
    actorName,
    targets,
  }: {
    organizationId: string;
    actorId: string;
    actorName: string;
    targets: AttachmentParentCleanupTarget[];
  },
): Promise<{ storagePaths: string[] }> {
  const storagePaths: string[] = [];

  for (const target of targets) {
    const attachments = await tx.attachment.findMany({
      where: { organizationId, entityType: target.entityType, entityId: target.entityId },
    });

    for (const attachment of attachments) {
      const result = await tx.attachment.deleteMany({
        where: {
          id: attachment.id,
          organizationId,
          entityType: target.entityType,
          entityId: target.entityId,
        },
      });
      if (result.count !== 1) {
        // Already removed by a concurrent operation — nothing to log, and
        // its Storage object is that operation's responsibility, not ours.
        continue;
      }

      await createActivity(tx, {
        organizationId,
        actorId,
        entityType: "ATTACHMENT",
        entityId: attachment.id,
        action: "FILE_DELETED",
        metadata: buildAttachmentActivityMetadata(
          attachment.originalName,
          target.entityType,
          target.parentEntityLabel,
          actorName,
        ),
      });

      storagePaths.push(attachment.storagePath);
    }
  }

  return { storagePaths };
}

/**
 * Best-effort Storage cleanup for a batch of paths — call only after the
 * caller's transaction has committed. A failure removing one object never
 * stops the rest, and never throws (a leftover Storage object is an
 * invisible orphan; the DB rows are already gone either way). Logs only a
 * failure count, never the paths, bucket, signed URLs, or any secret.
 */
export async function cleanupAttachmentStorageObjects(storagePaths: string[]): Promise<void> {
  if (storagePaths.length === 0) return;

  let failed = 0;
  for (const path of storagePaths) {
    const result = await removeAttachmentObject({ path });
    if (!result.ok) failed += 1;
  }

  if (failed > 0) {
    console.warn(`Attachment Storage cleanup: failed to remove ${failed} of ${storagePaths.length} object(s).`);
  }
}
