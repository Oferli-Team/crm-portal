"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { createActivity } from "@/lib/activity/create-activity";
import { buildProjectMetadata } from "@/lib/activity/project-metadata";
import { deleteAttachmentsForParent, cleanupAttachmentStorageObjects } from "@/lib/attachments/attachment-mutations";

export async function deleteProjectAction(projectId: string) {
  const { user, organizationId } = await getCurrentUserOrganization();

  // Delete, its Activity row, and Attachment cleanup are one atomic unit —
  // a failed Activity/Attachment insert (or an Invoice Restrict-FK
  // violation) rolls everything back together.
  const storagePaths = await prisma.$transaction(async (tx) => {
    // Snapshot taken before deletion — Activity.entityId is not a foreign
    // key, so this row (and its metadata) is what keeps the entry readable
    // once the Project row itself is gone.
    const existing = await tx.project.findFirst({
      where: { id: projectId, organizationId },
      include: { client: { select: { name: true } } },
    });

    if (!existing) {
      return null;
    }

    const result = await tx.project.deleteMany({
      where: { id: projectId, organizationId },
    });

    if (result.count === 0) {
      return null;
    }

    await createActivity(tx, {
      organizationId,
      actorId: user.id,
      entityType: "PROJECT",
      entityId: projectId,
      action: "DELETED",
      metadata: buildProjectMetadata(existing, existing.client.name, user.name),
    });

    // No further descendants carry Attachments — Task has no attachment
    // type at all, and Invoice's Restrict FK on projectId means a Project
    // with any Invoice can never reach this point in the first place.
    const { storagePaths } = await deleteAttachmentsForParent(tx, {
      organizationId,
      actorId: user.id,
      actorName: user.name,
      targets: [{ entityType: "PROJECT", entityId: projectId, parentEntityLabel: existing.name }],
    });

    return storagePaths;
  });

  if (storagePaths) {
    await cleanupAttachmentStorageObjects(storagePaths);
  }

  revalidatePath("/projects");
}
