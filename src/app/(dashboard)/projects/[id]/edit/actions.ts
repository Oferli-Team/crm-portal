"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { parseProjectForm } from "@/lib/validation/project";
import { withToast } from "@/lib/toast-url";
import { createActivity } from "@/lib/activity/create-activity";
import {
  diffProjectFields,
  buildProjectStatusChangedMetadata,
  buildProjectUpdatedMetadata,
} from "@/lib/activity/project-metadata";
import type { ProjectFormState } from "@/types";

export async function updateProjectAction(
  projectId: string,
  _prevState: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const { values, fieldErrors } = parseProjectForm(formData);

  if (Object.keys(fieldErrors).length > 0) {
    return { error: null, fieldErrors };
  }

  const { user, organizationId } = await getCurrentUserOrganization();

  // Changing the client is allowed, but only to one owned by this org —
  // re-verify server-side regardless of what the <select> offered. Also
  // resolves the (possibly new) client's name for Activity metadata.
  const client = await prisma.client.findFirst({
    where: { id: values.clientId, organizationId },
    select: { id: true, name: true },
  });

  if (!client) {
    return {
      error: null,
      fieldErrors: { clientId: "Select a valid client." },
    };
  }

  // Update and its Activity row(s) are one atomic unit — if any Activity
  // insert fails, the whole update rolls back with it.
  const outcome = await prisma.$transaction(async (tx) => {
    // Scoped by id + organizationId together — a foreign org's project id
    // simply doesn't match, indistinguishable from a nonexistent one. Also
    // doubles as the "before" snapshot for change-detection below.
    const existing = await tx.project.findFirst({
      where: { id: projectId, organizationId },
      include: { client: { select: { name: true } } },
    });

    if (!existing) {
      return "not_found" as const;
    }

    const result = await tx.project.updateMany({
      where: { id: projectId, organizationId },
      data: {
        name: values.name,
        status: values.status,
        startDate: values.startDate,
        endDate: values.endDate,
        clientId: values.clientId,
      },
    });

    if (result.count === 0) {
      return "not_found" as const;
    }

    // A pure resubmit of identical values creates no Activity at all.
    // "status" is always split out into its own STATUS_CHANGED event, so
    // it's never listed in an UPDATED event's changedFields even when both
    // fire together.
    const changedFields = diffProjectFields(existing, values);
    const statusChanged = changedFields.includes("status");
    const otherChangedFields = changedFields.filter((field) => field !== "status");

    if (statusChanged) {
      await createActivity(tx, {
        organizationId,
        actorId: user.id,
        entityType: "PROJECT",
        entityId: projectId,
        action: "STATUS_CHANGED",
        metadata: buildProjectStatusChangedMetadata(
          values,
          client.name,
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
        entityType: "PROJECT",
        entityId: projectId,
        action: "UPDATED",
        metadata: buildProjectUpdatedMetadata(values, client.name, otherChangedFields, user.name),
      });
    }

    return "updated" as const;
  });

  if (outcome === "not_found") {
    return { error: "This project could not be found." };
  }

  redirect(withToast("/projects", "Project updated"));
}
