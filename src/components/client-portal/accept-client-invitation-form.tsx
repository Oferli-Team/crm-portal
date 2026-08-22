"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import type { InviteAcceptState } from "@/types";

const initialState: InviteAcceptState = { error: null };

export function AcceptClientInvitationForm({
  action,
}: {
  /** A bound, zero-argument server action (acceptClientInvitationAction.bind(null, token)). */
  action: () => Promise<InviteAcceptState>;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction}>
      {state.error && (
        <p role="alert" className="mb-3 text-sm text-red-600">
          {state.error}
        </p>
      )}
      <Button type="submit" loading={pending} className="w-full">
        {pending ? "Joining…" : "Accept invitation"}
      </Button>
    </form>
  );
}
