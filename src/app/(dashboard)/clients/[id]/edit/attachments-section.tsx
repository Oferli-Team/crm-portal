import { AttachmentsSection } from "@/components/attachments/attachments-section";
import { uploadAttachmentAction, deleteAttachmentAction } from "./attachment-actions";

export function ClientAttachmentsSection({
  clientId,
  organizationId,
}: {
  clientId: string;
  organizationId: string;
}) {
  return (
    <AttachmentsSection
      entityType="CLIENT"
      entityId={clientId}
      organizationId={organizationId}
      parentLabel="client"
      uploadAction={uploadAttachmentAction.bind(null, clientId)}
      makeDeleteAction={(attachmentId) => deleteAttachmentAction.bind(null, clientId, attachmentId)}
    />
  );
}
