"use client";

import { useActionState } from "react";
import { CopyLinkButton } from "./copy-link-button";
import type { InvitationFormState } from "@/types";

const initialState: InvitationFormState = { error: null };

export function ResendInvitationForm({
  action,
  initialToken,
}: {
  action: (
    prevState: InvitationFormState,
    formData: FormData,
  ) => Promise<InvitationFormState>;
  initialToken: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  // Copy must always reflect the latest token — once a resend succeeds,
  // state.token holds the fresh one; until then it falls back to the prop.
  const token = state.token ?? initialToken;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-3">
        <CopyLinkButton token={token} />
        <form action={formAction}>
          <button
            type="submit"
            disabled={pending}
            className="rounded text-sm font-medium text-gray-700 transition-colors hover:text-gray-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? "Resending…" : "Resend"}
          </button>
        </form>
      </div>
      {state.error && (
        <p role="alert" className="text-xs text-red-600">
          {state.error}
        </p>
      )}
      {state.message && !state.error && (
        <p
          role="status"
          className={`text-xs ${state.emailFailed ? "text-amber-700" : "text-green-700"}`}
        >
          {state.message}
        </p>
      )}
    </div>
  );
}
