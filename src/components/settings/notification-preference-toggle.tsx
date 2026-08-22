"use client";

import { useTransition, type ChangeEvent } from "react";
import { useToast } from "@/components/toast/toast-provider";
import { updateNotificationPreferenceAction } from "@/app/(dashboard)/settings/actions";
import type { NotificationType } from "@/generated/prisma/enums";

/**
 * A single in-app/email checkbox for one NotificationType row — auto-saves
 * on change (no separate "Save" button/client-side state manager), the
 * same pattern AutoSubmitSelect already uses elsewhere in this app, just
 * calling the Server Action directly instead of submitting a form.
 */
export function NotificationPreferenceToggle({
  type,
  channel,
  defaultChecked,
  label,
  describedById,
}: {
  type: NotificationType;
  channel: "inApp" | "email";
  defaultChecked: boolean;
  /** Visually hidden but real accessible name — e.g. "In-app notifications for Role changed". */
  label: string;
  describedById: string;
}) {
  const [isPending, startTransition] = useTransition();
  const { showToast } = useToast();
  const inputId = `${type}-${channel}`;

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const enabled = event.currentTarget.checked;
    startTransition(async () => {
      try {
        await updateNotificationPreferenceAction(type, channel, enabled);
        showToast("Preference saved.");
      } catch {
        showToast("Failed to save preference.", "error");
      }
    });
  }

  return (
    <>
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <input
        id={inputId}
        type="checkbox"
        defaultChecked={defaultChecked}
        disabled={isPending}
        onChange={handleChange}
        aria-describedby={describedById}
        className="h-4 w-4 rounded border-gray-300 text-black focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      />
    </>
  );
}
