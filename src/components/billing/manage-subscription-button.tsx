"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast/toast-provider";
import { manageSubscriptionAction } from "@/app/(dashboard)/settings/billing/actions";

/** OWNER-only "Manage subscription" action — see plan-action-button.tsx's doc comment for the shared reasoning behind this pattern. */
export function ManageSubscriptionButton() {
  const [isPending, startTransition] = useTransition();
  const { showToast } = useToast();

  function handleClick() {
    startTransition(async () => {
      const result = await manageSubscriptionAction();
      showToast(result.message, result.ok ? "success" : "error");
    });
  }

  return (
    <Button type="button" disabled={isPending} loading={isPending} onClick={handleClick}>
      Manage subscription
    </Button>
  );
}
