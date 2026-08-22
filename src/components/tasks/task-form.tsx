"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/form-field";
import { TASK_STATUSES, TASK_PRIORITIES } from "@/lib/validation/task";
import type { TaskFormState } from "@/types";

const initialState: TaskFormState = { error: null };

type TaskFormDefaults = {
  title?: string;
  description?: string;
  projectId?: string;
  status?: string;
  priority?: string;
  dueDate?: string;
};

export function TaskForm({
  action,
  projects,
  defaultValues,
  submitLabel = "Create task",
  pendingLabel = "Creating…",
}: {
  action: (
    prevState: TaskFormState,
    formData: FormData,
  ) => Promise<TaskFormState>;
  projects: { id: string; label: string }[];
  defaultValues?: TaskFormDefaults;
  submitLabel?: string;
  pendingLabel?: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <FormField label="Title" htmlFor="title" required error={state.fieldErrors?.title}>
        <Input
          id="title"
          name="title"
          defaultValue={defaultValues?.title}
          required
          aria-invalid={!!state.fieldErrors?.title}
          aria-describedby={state.fieldErrors?.title ? "title-error" : undefined}
        />
      </FormField>

      <FormField label="Description" htmlFor="description">
        <Textarea
          id="description"
          name="description"
          rows={3}
          defaultValue={defaultValues?.description ?? ""}
        />
      </FormField>

      <FormField
        label="Project"
        htmlFor="projectId"
        required
        error={state.fieldErrors?.projectId}
      >
        <Select
          id="projectId"
          name="projectId"
          defaultValue={defaultValues?.projectId ?? ""}
          required
          aria-invalid={!!state.fieldErrors?.projectId}
          aria-describedby={
            state.fieldErrors?.projectId ? "projectId-error" : undefined
          }
        >
          <option value="" disabled>
            Select a project
          </option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.label}
            </option>
          ))}
        </Select>
      </FormField>

      <div className="grid grid-cols-2 gap-4">
        <FormField label="Status" htmlFor="status" error={state.fieldErrors?.status}>
          <Select
            id="status"
            name="status"
            defaultValue={defaultValues?.status ?? "TODO"}
            aria-invalid={!!state.fieldErrors?.status}
            aria-describedby={
              state.fieldErrors?.status ? "status-error" : undefined
            }
          >
            {TASK_STATUSES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField
          label="Priority"
          htmlFor="priority"
          error={state.fieldErrors?.priority}
        >
          <Select
            id="priority"
            name="priority"
            defaultValue={defaultValues?.priority ?? "MEDIUM"}
            aria-invalid={!!state.fieldErrors?.priority}
            aria-describedby={
              state.fieldErrors?.priority ? "priority-error" : undefined
            }
          >
            {TASK_PRIORITIES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </FormField>
      </div>

      <FormField
        label="Due date"
        htmlFor="dueDate"
        error={state.fieldErrors?.dueDate}
      >
        <Input
          id="dueDate"
          name="dueDate"
          type="date"
          defaultValue={defaultValues?.dueDate ?? ""}
          aria-invalid={!!state.fieldErrors?.dueDate}
          aria-describedby={
            state.fieldErrors?.dueDate ? "dueDate-error" : undefined
          }
        />
      </FormField>

      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}

      <div className="flex gap-3 pt-2">
        <Button type="submit" loading={pending}>
          {pending ? pendingLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}
