import { prisma } from "@/lib/prisma";
import { formatFileSize } from "@/lib/format";
import { EmptyState } from "@/components/ui/empty-state";
import { DeleteButton } from "@/components/ui/delete-button";
import { AttachmentUploadForm } from "@/components/attachments/attachment-upload-form";
import { MAX_ATTACHMENTS_PER_ENTITY } from "@/lib/storage/attachments-config";
import type { AttachmentEntityType } from "@/generated/prisma/enums";
import type { AttachmentUploadState } from "@/types";

/**
 * Entity-agnostic Attachments UI, extracted from the original Client-only
 * section (Stage 4) so Project (and any future entity) can reuse it as-is.
 * `parentLabel` (e.g. "client", "project") only affects wording — the data
 * query is always scoped by organizationId + entityType + entityId.
 */
export async function AttachmentsSection({
  entityType,
  entityId,
  organizationId,
  parentLabel,
  uploadAction,
  makeDeleteAction,
}: {
  entityType: AttachmentEntityType;
  entityId: string;
  organizationId: string;
  parentLabel: string;
  uploadAction: (
    prevState: AttachmentUploadState,
    formData: FormData,
  ) => Promise<AttachmentUploadState>;
  makeDeleteAction: (attachmentId: string) => () => Promise<void>;
}) {
  const attachments = await prisma.attachment.findMany({
    where: { organizationId, entityType, entityId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  const atLimit = attachments.length >= MAX_ATTACHMENTS_PER_ENTITY;

  return (
    <div className="mt-8 border-t border-gray-200 pt-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Attachments</h2>
        <p className="text-sm text-gray-500">
          {attachments.length} / {MAX_ATTACHMENTS_PER_ENTITY}
        </p>
      </div>

      <div className="mt-4">
        <AttachmentUploadForm
          action={uploadAction}
          disabled={atLimit}
          disabledReason={`This ${parentLabel} has reached the maximum of ${MAX_ATTACHMENTS_PER_ENTITY} attachments.`}
        />
      </div>

      {attachments.length === 0 ? (
        <EmptyState
          title="No attachments yet"
          description={`Upload a file to attach it to this ${parentLabel}.`}
        />
      ) : (
        <ul className="mt-4 divide-y divide-gray-200 rounded-lg border border-gray-200">
          {attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="flex items-center justify-between gap-4 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-gray-900">
                  {attachment.originalName}
                </p>
                <p className="text-xs text-gray-500">
                  {formatFileSize(attachment.sizeBytes)} ·{" "}
                  {attachment.createdAt.toLocaleDateString()}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-4">
                <a
                  href={`/api/attachments/${attachment.id}/download`}
                  className="rounded text-sm font-medium text-gray-700 transition-colors hover:text-gray-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
                >
                  Download
                </a>
                <DeleteButton
                  action={makeDeleteAction(attachment.id)}
                  itemName={attachment.originalName}
                  confirmTitle="Delete attachment"
                  confirmDescription={`Delete ${attachment.originalName}? This action cannot be undone.`}
                  successMessage="Attachment deleted"
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
