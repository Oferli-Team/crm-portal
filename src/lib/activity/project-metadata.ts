// Fields tracked for change-detection on Project Activity — deliberately a
// subset of the actual Project model. description/budget aren't part of
// this form at all, so they never enter the diff or metadata.
const PROJECT_TRACKED_FIELDS = ["name", "clientId", "status", "startDate", "endDate"] as const;

type ProjectTrackedSnapshot = {
  name: string;
  clientId: string;
  status: string;
  startDate: Date | null;
  endDate: Date | null;
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
 * Field names (never values) that differ between two Project snapshots.
 * May include "status" — callers are responsible for splitting that out
 * into its own STATUS_CHANGED event rather than listing it in an UPDATED
 * event's changedFields (see updateProjectAction).
 */
export function diffProjectFields(
  before: ProjectTrackedSnapshot,
  after: ProjectTrackedSnapshot,
): string[] {
  return PROJECT_TRACKED_FIELDS.filter((field) => !valuesEqual(before[field], after[field]));
}

type ProjectSnapshotMetadata = {
  name: string;
  status: string;
  clientName: string;
  actorName: string;
};

/** Shared shape for CREATED and DELETED — a full snapshot, no diff. */
export function buildProjectMetadata(
  project: Pick<ProjectTrackedSnapshot, "name" | "status">,
  clientName: string,
  actorName: string,
): ProjectSnapshotMetadata {
  return { name: project.name, status: project.status, clientName, actorName };
}

export type ProjectStatusChangedMetadata = {
  name: string;
  clientName: string;
  from: string;
  to: string;
  actorName: string;
};

export function buildProjectStatusChangedMetadata(
  project: Pick<ProjectTrackedSnapshot, "name">,
  clientName: string,
  from: string,
  to: string,
  actorName: string,
): ProjectStatusChangedMetadata {
  return { name: project.name, clientName, from, to, actorName };
}

export type ProjectUpdatedMetadata = {
  name: string;
  status: string;
  clientName: string;
  changedFields: string[];
  actorName: string;
};

/** changedFields must already have "status" filtered out by the caller. */
export function buildProjectUpdatedMetadata(
  project: Pick<ProjectTrackedSnapshot, "name" | "status">,
  clientName: string,
  changedFields: string[],
  actorName: string,
): ProjectUpdatedMetadata {
  return { name: project.name, status: project.status, clientName, changedFields, actorName };
}
