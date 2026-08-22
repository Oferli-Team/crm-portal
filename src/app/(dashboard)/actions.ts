"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserOrganization, setActiveOrganization } from "@/lib/current-user";
import { withToast } from "@/lib/toast-url";

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

/**
 * Switches the current user's active organization. organizationId is
 * untrusted input (it comes straight from a switcher button click) —
 * setActiveOrganization() re-verifies a Membership row exists for
 * (user, organizationId) before touching the cookie, and throws the exact
 * same message whether the id belongs to someone else's organization or
 * doesn't exist at all, so neither case can be distinguished from outside.
 */
export async function switchOrganizationAction(organizationId: string): Promise<void> {
  await setActiveOrganization(organizationId);

  // Every dashboard route scopes its data by the active organization, so a
  // switch invalidates the whole layout subtree at once (and purges the
  // client router cache) rather than enumerating each affected route.
  revalidatePath("/", "layout");

  redirect(withToast("/dashboard", "Switched organization"));
}

/**
 * Marks one Notification read for the current staff user. Scoped by
 * {id, recipientId, organizationId} together — never by id alone — so a
 * crafted id belonging to someone else, or to another organization, simply
 * matches zero rows instead of erroring; that's indistinguishable from a
 * nonexistent id, which is the same "generic no-op" every other cross-
 * tenant mutation in this app already falls back to. `readAt: null` in the
 * WHERE makes a duplicate click idempotent — a no-op, not a second write.
 */
export async function markNotificationReadAction(notificationId: string): Promise<void> {
  const { user, organizationId } = await getCurrentUserOrganization();

  await prisma.notification.updateMany({
    where: { id: notificationId, recipientId: user.id, organizationId, readAt: null },
    data: { readAt: new Date() },
  });

  // The bell/badge render in the layout itself, not a specific page — same
  // reasoning as switchOrganizationAction's own revalidation above.
  revalidatePath("/", "layout");
}

/** Bulk equivalent of markNotificationReadAction — same scoping, same idempotency. */
export async function markAllNotificationsReadAction(): Promise<void> {
  const { user, organizationId } = await getCurrentUserOrganization();

  await prisma.notification.updateMany({
    where: { recipientId: user.id, organizationId, readAt: null },
    data: { readAt: new Date() },
  });

  revalidatePath("/", "layout");
}
