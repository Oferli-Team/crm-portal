import { formatFileSize } from "@/lib/format";
import { EmptyState } from "@/components/ui/empty-state";
import type { PortalAttachment } from "@/lib/client-portal/attachments";

// Read-only by design: no upload form, no delete button, and never a
// staff uploader name/email, storage bucket, or storage path — those
// never leave the query layer. The Download link always points at the
// portal-specific route, never /api/attachments/... (the staff one).
export function PortalAttachmentsList({
  attachments,
  emptyDescription,
}: {
  attachments: PortalAttachment[];
  emptyDescription: string;
}) {
  if (attachments.length === 0) {
    return <EmptyState title="No files yet" description={emptyDescription} />;
  }

  return (
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
          <a
            href={`/api/portal/attachments/${attachment.id}/download`}
            className="shrink-0 rounded text-sm font-medium text-gray-700 transition-colors hover:text-gray-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
          >
            Download
          </a>
        </li>
      ))}
    </ul>
  );
}
