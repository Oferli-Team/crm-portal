"use client";

import { useTransition } from "react";
import { useToast } from "@/components/toast/toast-provider";
import { skipOnboardingStepAction } from "@/lib/onboarding/actions";
import type { OnboardingStepKey } from "@/generated/prisma/enums";

/**
 * Same "use client" + useTransition + direct-Server-Action-call pattern as
 * ResetPreferencesButton/NotificationDropdown — the action's own
 * `revalidatePath("/dashboard")` (src/lib/onboarding/actions.ts) refreshes
 * this row's status without a manual reload or router.refresh() call.
 *
 * Stage 5 polish: on success this button itself unmounts (the row's own
 * `showSkip` flips false once its status is SKIPPED) — `returnFocusId`
 * moves focus to the row's own label so it isn't silently dropped to
 * <body>, the same pattern DismissOnboardingButton now uses for the whole
 * card.
 */
export function SkipStepButton({
  stepKey,
  label,
  returnFocusId,
}: {
  stepKey: OnboardingStepKey;
  label: string;
  returnFocusId: string;
}) {
  const [isPending, startTransition] = useTransition();
  const { showToast } = useToast();

  function handleClick() {
    startTransition(async () => {
      const result = await skipOnboardingStepAction(stepKey);
      if (!result.ok) {
        showToast(result.message, "error");
        return;
      }
      document.getElementById(returnFocusId)?.focus();
    });
  }

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={handleClick}
      aria-label={`Skip: ${label}`}
      className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {isPending ? "Skipping…" : "Skip"}
    </button>
  );
}
