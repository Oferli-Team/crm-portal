"use client";

import { useTransition } from "react";
import { useToast } from "@/components/toast/toast-provider";
import { resetNotificationPreferencesAction } from "@/app/(dashboard)/settings/actions";

export function ResetPreferencesButton() {
  const [isPending, startTransition] = useTransition();
  const { showToast } = useToast();

  function handleClick() {
    startTransition(async () => {
      try {
        await resetNotificationPreferencesAction();
        showToast("Notification preferences reset to defaults.");
      } catch {
        showToast("Failed to reset preferences.", "error");
      }
    });
  }

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={handleClick}
      className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
    >
      Reset to defaults
    </button>
  );
}
