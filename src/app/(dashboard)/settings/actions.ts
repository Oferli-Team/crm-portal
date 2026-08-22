"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { updateNotificationPreference, resetNotificationPreferences } from "@/lib/notifications/preferences";
import type { NotificationType } from "@/generated/prisma/enums";

/**
 * userId is always getCurrentUserOrganization()'s own resolved user — never
 * accepted as a parameter here, so there is no client input capable of
 * targeting another user's preferences at all, not even a crafted one.
 */
export async function updateNotificationPreferenceAction(
  type: NotificationType,
  channel: "inApp" | "email",
  enabled: boolean,
): Promise<void> {
  const { user } = await getCurrentUserOrganization();

  await updateNotificationPreference(
    user.id,
    type,
    channel === "inApp" ? { inAppEnabled: enabled } : { emailEnabled: enabled },
  );

  revalidatePath("/settings/notifications");
  // An in-app toggle can change the bell's unread count/dropdown contents
  // (see getDisabledInAppTypes wired into the layout) — the same
  // whole-layout revalidation switchOrganizationAction already uses for
  // exactly this reason.
  revalidatePath("/", "layout");
}

/** Deletes the user's preference rows rather than writing true/true — see resetNotificationPreferences's own doc comment. */
export async function resetNotificationPreferencesAction(): Promise<void> {
  const { user } = await getCurrentUserOrganization();

  await resetNotificationPreferences(user.id);

  revalidatePath("/settings/notifications");
  revalidatePath("/", "layout");
}
