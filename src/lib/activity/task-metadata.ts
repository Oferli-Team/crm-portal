// Fields tracked for change-detection on Task Activity — deliberately a
// subset of the actual Task model. description isn't included, and
// assigneeId is never touched here at all: no form or action in this app
// currently reads or writes it (Task.assigneeId is unused schema
// scaffolding), so there's nothing to diff or log for it yet.
const TASK_TRACKED_FIELDS = ["title", "projectId", "status", "priority", "dueDate"] as const;

type TaskTrackedSnapshot = {
  title: string;
  projectId: string;
  status: string;
  priority: string;
  dueDate: Date | null;
};

function valuesEqual(a: string | Date | null, b: string | Date | null): boolean {
  if (a instanceof Date || b instanceof Date) {
    const at = a instanceof Date ? a.getTime() : null;
    const bt = b instanceof Date ? b.getTime() : null;
    return at === bt;
  }
  return a === b;
}

/**
 * Field names (never values) that differ between two Task snapshots. May
 * include "status" — callers split that out into its own STATUS_CHANGED
 * event rather than listing it in an UPDATED event's changedFields (see
 * updateTaskAction).
 */
export function diffTaskFields(
  before: TaskTrackedSnapshot,
  after: TaskTrackedSnapshot,
): string[] {
  return TASK_TRACKED_FIELDS.filter((field) => !valuesEqual(before[field], after[field]));
}

type TaskSnapshotMetadata = {
  title: string;
  status: string;
  priority: string;
  projectName: string;
  actorName: string;
};

/** Shared shape for CREATED and DELETED — a full snapshot, no diff. */
export function buildTaskMetadata(
  task: Pick<TaskTrackedSnapshot, "title" | "status" | "priority">,
  projectName: string,
  actorName: string,
): TaskSnapshotMetadata {
  return { title: task.title, status: task.status, priority: task.priority, projectName, actorName };
}

export type TaskStatusChangedMetadata = {
  title: string;
  projectName: string;
  from: string;
  to: string;
  actorName: string;
};

export function buildTaskStatusChangedMetadata(
  task: Pick<TaskTrackedSnapshot, "title">,
  projectName: string,
  from: string,
  to: string,
  actorName: string,
): TaskStatusChangedMetadata {
  return { title: task.title, projectName, from, to, actorName };
}

export type TaskUpdatedMetadata = {
  title: string;
  status: string;
  priority: string;
  projectName: string;
  changedFields: string[];
  actorName: string;
};

/** changedFields must already have "status" filtered out by the caller. */
export function buildTaskUpdatedMetadata(
  task: Pick<TaskTrackedSnapshot, "title" | "status" | "priority">,
  projectName: string,
  changedFields: string[],
  actorName: string,
): TaskUpdatedMetadata {
  return {
    title: task.title,
    status: task.status,
    priority: task.priority,
    projectName,
    changedFields,
    actorName,
  };
}
