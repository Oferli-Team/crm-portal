"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast/toast-provider";
import { requestPlanChangeAction } from "@/app/(dashboard)/settings/billing/actions";
import type { PlanKey } from "@/lib/billing/plans";

/**
 * Billing & Subscriptions Stage 3, redirect behavior added in Stage 4.
 * Same client-button pattern as ResetPreferencesButton
 * (src/components/settings/reset-preferences-button.tsx): "use client",
 * useTransition, calls the Server Action directly, then toasts the
 * result. When a provider *is* configured, requestPlanChangeAction
 * redirects server-side instead of returning a value — Next's own Server
 * Action runtime intercepts that before this component ever sees a
 * resolved result, so the browser simply navigates and showToast is never
 * reached on that path; only the "not configured"/validation-failure
 * branches ever produce a `{ ok, message }` this component renders as a
 * toast. The action itself re-validates role/plan server-side regardless
 * of this button's own disabled state — this component's `disabled` prop
 * only controls the client affordance.
 */
export function PlanActionButton({
  planKey,
  label,
  disabled,
  disabledReason,
}: {
  planKey: PlanKey;
  label: string;
  disabled: boolean;
  disabledReason?: string;
}) {
  const [isPending, startTransition] = useTransition();
  const { showToast } = useToast();

  function handleClick() {
    startTransition(async () => {
      const result = await requestPlanChangeAction(planKey);
      showToast(result.message, result.ok ? "success" : "error");
    });
  }

  return (
    <div>
      <Button
        type="button"
        className="w-full"
        disabled={disabled || isPending}
        loading={isPending}
        onClick={handleClick}
      >
        {label}
      </Button>
      {disabled && disabledReason && <p className="mt-1 text-xs text-gray-500">{disabledReason}</p>}
    </div>
  );
}
