import { AttachmentsSection } from "@/components/attachments/attachments-section";
import { uploadAttachmentAction, deleteAttachmentAction } from "./attachment-actions";

export function InvoiceAttachmentsSection({
  invoiceId,
  organizationId,
}: {
  invoiceId: string;
  organizationId: string;
}) {
  return (
    <AttachmentsSection
      entityType="INVOICE"
      entityId={invoiceId}
      organizationId={organizationId}
      parentLabel="invoice"
      uploadAction={uploadAttachmentAction.bind(null, invoiceId)}
      makeDeleteAction={(attachmentId) => deleteAttachmentAction.bind(null, invoiceId, attachmentId)}
    />
  );
}
