"use client";

import { useActionState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import type { AttachmentUploadState } from "@/types";

const initialState: AttachmentUploadState = { error: null };

const ACCEPTED_EXTENSIONS =
  ".pdf,.png,.jpg,.jpeg,.webp,.txt,.csv,.doc,.docx,.xls,.xlsx";

export function AttachmentUploadForm({
  action,
  disabled = false,
  disabledReason,
}: {
  action: (
    prevState: AttachmentUploadState,
    formData: FormData,
  ) => Promise<AttachmentUploadState>;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  // Clears the file input after a successful upload — the page's own data
  // refresh (via revalidatePath in the action) is what makes the new file
  // show up in the list; this just resets the control itself.
  useEffect(() => {
    if (!pending && state.error === null) {
      formRef.current?.reset();
    }
  }, [pending, state]);

  return (
    <form ref={formRef} action={formAction} className="flex flex-wrap items-start gap-3">
      <div className="min-w-[220px] flex-1">
        <input
          type="file"
          name="file"
          required
          disabled={disabled || pending}
          accept={ACCEPTED_EXTENSIONS}
          className="block w-full text-sm text-gray-700 file:mr-3 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-gray-700 hover:file:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-60"
        />
        {state.error && (
          <p role="alert" className="mt-1 text-sm text-red-600">
            {state.error}
          </p>
        )}
        {disabled && disabledReason && !state.error && (
          <p className="mt-1 text-sm text-gray-500">{disabledReason}</p>
        )}
      </div>
      <Button type="submit" loading={pending} disabled={disabled}>
        {pending ? "Uploading…" : "Upload"}
      </Button>
    </form>
  );
}
