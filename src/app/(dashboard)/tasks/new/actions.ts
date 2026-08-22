"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { parseTaskForm, deriveCompletedAt } from "@/lib/validation/task";
import { withToast } from "@/lib/toast-url";
import { createActivity } from "@/lib/activity/create-activity";
import { buildTaskMetadata } from "@/lib/activity/task-metadata";
import type { TaskFormState } from "@/types";

export async function createTaskAction(
  _prevState: TaskFormState,
  formData: FormData,
): Promise<TaskFormState> {
  const { values, fieldErrors } = parseTaskForm(formData);

  if (Object.keys(fieldErrors).length > 0) {
    return { error: null, fieldErrors };
  }

  const { user, organizationId } = await getCurrentUserOrganization();

  // The <select> only lists this org's projects, but the submitted value
  // is still client-controlled input — re-verify ownership server-side so a
  // tampered projectId can never attach a task to another org's project.
  const project = await prisma.project.findFirst({
    where: { id: values.projectId, organizationId },
    select: { id: true, name: true },
  });

  if (!project) {
    return {
      error: null,
      fieldErrors: { projectId: "Select a valid project." },
    };
  }

  // Task create and its Activity row are one atomic unit — if the
  // Activity insert fails for any reason, the Task create rolls back with
  // it rather than leaving an unlogged row behind.
  await prisma.$transaction(async (tx) => {
    const task = await tx.task.create({
      data: {
        title: values.title,
        description: values.description,
        status: values.status,
        priority: values.priority,
        dueDate: values.dueDate,
        completedAt: deriveCompletedAt(values.status, null),
        projectId: values.projectId,
      },
    });

    await createActivity(tx, {
      organizationId,
      actorId: user.id,
      entityType: "TASK",
      entityId: task.id,
      action: "CREATED",
      metadata: buildTaskMetadata(task, project.name, user.name),
    });
  });

  redirect(withToast("/tasks", "Task created"));
}
