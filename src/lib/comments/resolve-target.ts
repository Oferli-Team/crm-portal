import type { Prisma } from "@/generated/prisma/client";
import type { CommentEntityType } from "@/generated/prisma/enums";

export type CommentTarget = {
  entityType: CommentEntityType;
  entityId: string;
  /** The Project's own name, or the Task's own title — the exact display string used for Activity/Notification "parentEntityLabel". */
  label: string;
};

/**
 * Comments & Mentions Stage 3 (docs/comments-architecture.md §4): the one
 * place a Project/Task id is ever resolved before attaching a Comment to
 * it. Deliberately never a bare `findFirst({ where: { id } })` — every
 * lookup is scoped by `{ id, organizationId }` (Task via its parent
 * Project's organizationId, matching this app's own existing convention —
 * see src/app/(dashboard)/tasks/actions.ts's deleteTaskAction, which scopes
 * the same way rather than through Task's own denormalized organizationId
 * column), so a foreign-org id and a genuinely nonexistent id are
 * indistinguishable: both resolve to `null`, never a different error or
 * message that could confirm "yes, that id exists, just not in your org."
 */
export async function resolveCommentTarget(
  tx: Prisma.TransactionClient,
  params: { organizationId: string; entityType: CommentEntityType; entityId: string },
): Promise<CommentTarget | null> {
  const { organizationId, entityType, entityId } = params;

  if (entityType === "PROJECT") {
    const project = await tx.project.findFirst({
      where: { id: entityId, organizationId },
      select: { id: true, name: true },
    });
    if (!project) return null;
    return { entityType, entityId: project.id, label: project.name };
  }

  if (entityType === "TASK") {
    const task = await tx.task.findFirst({
      where: { id: entityId, project: { organizationId } },
      select: { id: true, title: true },
    });
    if (!task) return null;
    return { entityType, entityId: task.id, label: task.title };
  }

  // Defensive only — CommentEntityType has no other value today.
  return null;
}
