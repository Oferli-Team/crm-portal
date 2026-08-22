"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { parseTaskForm, deriveCompletedAt } from "@/lib/validation/task";
import { withToast } from "@/lib/toast-url";
import { createActivity } from "@/lib/activity/create-activity";
import {
  diffTaskFields,
  buildTaskStatusChangedMetadata,
  buildTaskUpdatedMetadata,
} from "@/lib/activity/task-metadata";
import type { TaskFormState } from "@/types";

export async function updateTaskAction(
  taskId: string,
  _prevState: TaskFormState,
  formData: FormData,
): Promise<TaskFormState> {
  const { values, fieldErrors } = parseTaskForm(formData);

  if (Object.keys(fieldErrors).length > 0) {
    return { error: null, fieldErrors };
  }

  const { user, organizationId } = await getCurrentUserOrganization();

  // Changing the project is allowed, but only to one owned by this org —
  // re-verify server-side regardless of what the <select> offered. Also
  // resolves the (possibly new) project's name for Activity metadata.
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

  // Update and its Activity row(s) are one atomic unit — if any Activity
  // insert fails, the whole update rolls back with it.
  const outcome = await prisma.$transaction(async (tx) => {
    // Scoped through the task's *current* project's organization — never
    // by id alone. Also doubles as the "before" snapshot for
    // change-detection, and gives us the existing completedAt.
    const existing = await tx.task.findFirst({
      where: { id: taskId, project: { organizationId } },
    });

    if (!existing) {
      return "not_found" as const;
    }

    const result = await tx.task.updateMany({
      where: { id: taskId, project: { organizationId } },
      data: {
        title: values.title,
        description: values.description,
        status: values.status,
        priority: values.priority,
        dueDate: values.dueDate,
        completedAt: deriveCompletedAt(values.status, existing.completedAt),
        projectId: values.projectId,
      },
    });

    if (result.count === 0) {
      return "not_found" as const;
    }

    // A pure resubmit of identical values creates no Activity at all.
    // "status" is always split out into its own STATUS_CHANGED event, so
    // it's never listed in an UPDATED event's changedFields even when both
    // fire together.
    const changedFields = diffTaskFields(existing, values);
    const statusChanged = changedFields.includes("status");
    const otherChangedFields = changedFields.filter((field) => field !== "status");

    if (statusChanged) {
      await createActivity(tx, {
        organizationId,
        actorId: user.id,
        entityType: "TASK",
        entityId: taskId,
        action: "STATUS_CHANGED",
        metadata: buildTaskStatusChangedMetadata(
          values,
          project.name,
          existing.status,
          values.status,
          user.name,
        ),
      });
    }

    if (otherChangedFields.length > 0) {
      await createActivity(tx, {
        organizationId,
        actorId: user.id,
        entityType: "TASK",
        entityId: taskId,
        action: "UPDATED",
        metadata: buildTaskUpdatedMetadata(values, project.name, otherChangedFields, user.name),
      });
    }

    return "updated" as const;
  });

  if (outcome === "not_found") {
    return { error: "This task could not be found." };
  }

  redirect(withToast("/tasks", "Task updated"));
}
