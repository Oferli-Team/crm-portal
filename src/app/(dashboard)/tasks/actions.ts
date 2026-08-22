"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { createActivity } from "@/lib/activity/create-activity";
import { buildTaskMetadata } from "@/lib/activity/task-metadata";

export async function deleteTaskAction(taskId: string) {
  const { user, organizationId } = await getCurrentUserOrganization();

  // Delete and its Activity row are one atomic unit — a failed Activity
  // insert rolls the delete back too.
  await prisma.$transaction(async (tx) => {
    // Snapshot taken before deletion — Activity.entityId is not a foreign
    // key, so this row (and its metadata) is what keeps the entry readable
    // once the Task row itself is gone.
    const existing = await tx.task.findFirst({
      where: { id: taskId, project: { organizationId } },
      include: { project: { select: { name: true } } },
    });

    if (!existing) {
      return;
    }

    const result = await tx.task.deleteMany({
      where: { id: taskId, project: { organizationId } },
    });

    if (result.count === 0) {
      return;
    }

    await createActivity(tx, {
      organizationId,
      actorId: user.id,
      entityType: "TASK",
      entityId: taskId,
      action: "DELETED",
      metadata: buildTaskMetadata(existing, existing.project.name, user.name),
    });
  });

  revalidatePath("/tasks");
}
