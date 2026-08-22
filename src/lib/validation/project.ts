import type { ProjectFormState } from "@/types";

export const PROJECT_STATUSES = [
  "PLANNING",
  "IN_PROGRESS",
  "ON_HOLD",
  "COMPLETED",
  "CANCELLED",
] as const;
export type ProjectStatusValue = (typeof PROJECT_STATUSES)[number];

export type ParsedProjectInput = {
  name: string;
  clientId: string;
  status: ProjectStatusValue;
  startDate: Date | null;
  endDate: Date | null;
};

function parseDate(raw: string): Date | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseProjectForm(formData: FormData): {
  values: ParsedProjectInput;
  fieldErrors: NonNullable<ProjectFormState["fieldErrors"]>;
} {
  const name = String(formData.get("name") ?? "").trim();
  const clientId = String(formData.get("clientId") ?? "").trim();
  const status = String(formData.get("status") ?? "PLANNING");
  const startDateRaw = String(formData.get("startDate") ?? "").trim();
  const endDateRaw = String(formData.get("endDate") ?? "").trim();

  const fieldErrors: NonNullable<ProjectFormState["fieldErrors"]> = {};

  if (!name) {
    fieldErrors.name = "Name is required.";
  }

  if (!clientId) {
    fieldErrors.clientId = "Select a client.";
  }

  const isValidStatus = PROJECT_STATUSES.includes(status as ProjectStatusValue);
  if (!isValidStatus) {
    fieldErrors.status = "Select a valid status.";
  }

  if (startDateRaw && !parseDate(startDateRaw)) {
    fieldErrors.startDate = "Enter a valid start date.";
  }

  if (endDateRaw && !parseDate(endDateRaw)) {
    fieldErrors.endDate = "Enter a valid end date.";
  }

  const startDate = parseDate(startDateRaw);
  const endDate = parseDate(endDateRaw);

  if (startDate && endDate && endDate < startDate) {
    fieldErrors.endDate = "End date cannot be before the start date.";
  }

  return {
    values: {
      name,
      clientId,
      status: isValidStatus ? (status as ProjectStatusValue) : "PLANNING",
      startDate,
      endDate,
    },
    fieldErrors,
  };
}
