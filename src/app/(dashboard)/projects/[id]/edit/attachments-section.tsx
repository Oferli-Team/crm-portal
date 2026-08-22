import { AttachmentsSection } from "@/components/attachments/attachments-section";
import { uploadAttachmentAction, deleteAttachmentAction } from "./attachment-actions";

export function ProjectAttachmentsSection({
  projectId,
  organizationId,
}: {
  projectId: string;
  organizationId: string;
}) {
  return (
    <AttachmentsSection
      entityType="PROJECT"
      entityId={projectId}
      organizationId={organizationId}
      parentLabel="project"
      uploadAction={uploadAttachmentAction.bind(null, projectId)}
      makeDeleteAction={(attachmentId) => deleteAttachmentAction.bind(null, projectId, attachmentId)}
    />
  );
}
