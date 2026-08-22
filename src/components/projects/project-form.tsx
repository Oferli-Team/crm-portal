"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { FormField } from "@/components/ui/form-field";
import { PROJECT_STATUSES } from "@/lib/validation/project";
import type { ProjectFormState } from "@/types";

const initialState: ProjectFormState = { error: null };

type ProjectFormDefaults = {
  name?: string;
  clientId?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
};

export function ProjectForm({
  action,
  clients,
  defaultValues,
  submitLabel = "Create project",
  pendingLabel = "Creating…",
}: {
  action: (
    prevState: ProjectFormState,
    formData: FormData,
  ) => Promise<ProjectFormState>;
  clients: { id: string; name: string }[];
  defaultValues?: ProjectFormDefaults;
  submitLabel?: string;
  pendingLabel?: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <FormField label="Name" htmlFor="name" required error={state.fieldErrors?.name}>
        <Input
          id="name"
          name="name"
          defaultValue={defaultValues?.name}
          required
          aria-invalid={!!state.fieldErrors?.name}
          aria-describedby={state.fieldErrors?.name ? "name-error" : undefined}
        />
      </FormField>

      <FormField
        label="Client"
        htmlFor="clientId"
        required
        error={state.fieldErrors?.clientId}
      >
        <Select
          id="clientId"
          name="clientId"
          defaultValue={defaultValues?.clientId ?? ""}
          required
          aria-invalid={!!state.fieldErrors?.clientId}
          aria-describedby={
            state.fieldErrors?.clientId ? "clientId-error" : undefined
          }
        >
          <option value="" disabled>
            Select a client
          </option>
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.name}
            </option>
          ))}
        </Select>
      </FormField>

      <FormField label="Status" htmlFor="status" error={state.fieldErrors?.status}>
        <Select
          id="status"
          name="status"
          defaultValue={defaultValues?.status ?? "PLANNING"}
          aria-invalid={!!state.fieldErrors?.status}
          aria-describedby={state.fieldErrors?.status ? "status-error" : undefined}
        >
          {PROJECT_STATUSES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </FormField>

      <div className="grid grid-cols-2 gap-4">
        <FormField
          label="Start date"
          htmlFor="startDate"
          error={state.fieldErrors?.startDate}
        >
          <Input
            id="startDate"
            name="startDate"
            type="date"
            defaultValue={defaultValues?.startDate ?? ""}
            aria-invalid={!!state.fieldErrors?.startDate}
            aria-describedby={
              state.fieldErrors?.startDate ? "startDate-error" : undefined
            }
          />
        </FormField>

        <FormField
          label="End date"
          htmlFor="endDate"
          error={state.fieldErrors?.endDate}
        >
          <Input
            id="endDate"
            name="endDate"
            type="date"
            defaultValue={defaultValues?.endDate ?? ""}
            aria-invalid={!!state.fieldErrors?.endDate}
            aria-describedby={
              state.fieldErrors?.endDate ? "endDate-error" : undefined
            }
          />
        </FormField>
      </div>

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
