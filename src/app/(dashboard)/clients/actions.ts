"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { createActivity } from "@/lib/activity/create-activity";
import { buildClientActivityMetadata } from "@/lib/activity/client-metadata";
import { deleteAttachmentsForParent, cleanupAttachmentStorageObjects } from "@/lib/attachments/attachment-mutations";

export async function deleteClientAction(clientId: string) {
  const { user, organizationId } = await getCurrentUserOrganization();

  // Delete, its (conditional) Activity row, and Attachment cleanup are one
  // atomic unit — a failed Activity/Attachment insert (or an Invoice
  // Restrict-FK violation cascading from the delete itself) rolls
  // everything back together, including any Attachment rows this would
  // otherwise have cleaned up.
  const storagePaths = await prisma.$transaction(async (tx) => {
    // Snapshot taken before deletion — Activity.entityId is not a foreign
    // key, so this row (and its metadata) is what keeps the entry readable
    // once the Client row itself is gone.
    const existing = await tx.client.findFirst({
      where: { id: clientId, organizationId },
    });

    if (!existing) {
      return null;
    }

    // Projects that will cascade-delete alongside this Client (Project.clientId
    // is onDelete: Cascade) — queried before the delete, since Postgres
    // removes them silently at the SQL level with no application code
    // running for them; their own Attachments would otherwise be orphaned.
    const childProjects = await tx.project.findMany({
      where: { clientId, organizationId },
      select: { id: true, name: true },
    });

    const result = await tx.client.deleteMany({
      where: { id: clientId, organizationId },
    });

    if (result.count === 0) {
      return null;
    }

    await createActivity(tx, {
      organizationId,
      actorId: user.id,
      entityType: "CLIENT",
      entityId: clientId,
      action: "DELETED",
      metadata: buildClientActivityMetadata(existing, user.name),
    });

    const { storagePaths } = await deleteAttachmentsForParent(tx, {
      organizationId,
      actorId: user.id,
      actorName: user.name,
      targets: [
        { entityType: "CLIENT", entityId: clientId, parentEntityLabel: existing.name },
        ...childProjects.map((project) => ({
          entityType: "PROJECT" as const,
          entityId: project.id,
          parentEntityLabel: project.name,
        })),
      ],
    });

    return storagePaths;
  });

  if (storagePaths) {
    await cleanupAttachmentStorageObjects(storagePaths);
  }

  revalidatePath("/clients");
}
