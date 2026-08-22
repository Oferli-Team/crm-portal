"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { uploadAttachmentForEntity, deleteAttachmentForEntity } from "@/lib/attachments/attachment-mutations";
import type { AttachmentUploadState } from "@/types";

export async function uploadAttachmentAction(
  clientId: string,
  _prevState: AttachmentUploadState,
  formData: FormData,
): Promise<AttachmentUploadState> {
  const { user, organizationId } = await getCurrentUserOrganization();

  // Scoped by id + organizationId — a foreign org's client id simply
  // doesn't match, indistinguishable from a nonexistent one.
  const client = await prisma.client.findFirst({
    where: { id: clientId, organizationId },
    select: { id: true, name: true },
  });
  if (!client) {
    return { error: "This client could not be found." };
  }

  const result = await uploadAttachmentForEntity({
    organizationId,
    actorId: user.id,
    actorName: user.name,
    entityType: "CLIENT",
    entityId: clientId,
    parentEntityLabel: client.name,
    formData,
  });

  if (result.error === null) {
    revalidatePath(`/clients/${clientId}/edit`);
  }
  return result;
}

export async function deleteAttachmentAction(clientId: string, attachmentId: string): Promise<void> {
  const { user, organizationId } = await getCurrentUserOrganization();

  await deleteAttachmentForEntity({
    organizationId,
    actorId: user.id,
    actorName: user.name,
    attachmentId,
    entityType: "CLIENT",
    resolveParentLabel: async (entityId) => {
      const parentClient = await prisma.client.findFirst({
        where: { id: entityId, organizationId },
        select: { name: true },
      });
      return parentClient?.name ?? null;
    },
  });

  revalidatePath(`/clients/${clientId}/edit`);
}
