"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { uploadAttachmentForEntity, deleteAttachmentForEntity } from "@/lib/attachments/attachment-mutations";
import type { AttachmentUploadState } from "@/types";

export async function uploadAttachmentAction(
  projectId: string,
  _prevState: AttachmentUploadState,
  formData: FormData,
): Promise<AttachmentUploadState> {
  const { user, organizationId } = await getCurrentUserOrganization();

  // Scoped by id + organizationId — a foreign org's project id simply
  // doesn't match, indistinguishable from a nonexistent one.
  const project = await prisma.project.findFirst({
    where: { id: projectId, organizationId },
    select: { id: true, name: true },
  });
  if (!project) {
    return { error: "This project could not be found." };
  }

  const result = await uploadAttachmentForEntity({
    organizationId,
    actorId: user.id,
    actorName: user.name,
    entityType: "PROJECT",
    entityId: projectId,
    parentEntityLabel: project.name,
    formData,
  });

  if (result.error === null) {
    revalidatePath(`/projects/${projectId}/edit`);
  }
  return result;
}

export async function deleteAttachmentAction(projectId: string, attachmentId: string): Promise<void> {
  const { user, organizationId } = await getCurrentUserOrganization();

  await deleteAttachmentForEntity({
    organizationId,
    actorId: user.id,
    actorName: user.name,
    attachmentId,
    entityType: "PROJECT",
    resolveParentLabel: async (entityId) => {
      const parentProject = await prisma.project.findFirst({
        where: { id: entityId, organizationId },
        select: { name: true },
      });
      return parentProject?.name ?? null;
    },
  });

  revalidatePath(`/projects/${projectId}/edit`);
}
