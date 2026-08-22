import { redirect } from "next/navigation";
import { getVerifiedAuthUser } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserOrganization, getOrganizationSwitcherItems } from "@/lib/current-user";
import { getRecentNotifications, getUnreadNotificationCount } from "@/lib/notifications/queries";
import { getDisabledInAppTypes } from "@/lib/notifications/preferences";
import { formatNotification } from "@/lib/notifications/format-notification";
import type { NotificationBellItem } from "@/components/notifications/notification-bell";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { TEST_MODE } from "@/lib/test-mode";

const RECENT_NOTIFICATIONS_LIMIT = 10;

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Stage 6.2.1: shares one request-scoped auth.getUser() call with
  // getOrCreateUser() below (getCurrentUserOrganization ->
  // getOrCreateUser) instead of each making its own independent network
  // round-trip — see getVerifiedAuthUser()'s own doc comment for why
  // that redundancy was causing spurious session-loss after mutations.
  const user = await getVerifiedAuthUser();

  if (!user) {
    redirect("/login");
  }

  // A Client Portal-only identity (a PortalUser with no staff Membership)
  // must never fall through to getOrganizationSwitcherItems() below — that
  // chain (via getCurrentUserOrganization) auto-provisions a brand-new
  // personal Organization for anyone with no existing Membership, which
  // would silently hand a portal user their own empty CRM instead of
  // routing them to their actual portal. This check is deliberately a
  // lightweight existence query, not a reimplementation of that
  // resolution logic — everything below is unchanged.
  const hasMembership = await prisma.membership.findFirst({
    where: { userId: user.id },
    select: { id: true },
  });

  if (!hasMembership) {
    const portalUser = await prisma.portalUser.findUnique({
      where: { id: user.id },
      select: { id: true },
    });
    if (portalUser) {
      redirect("/portal");
    }
    // Neither a Membership nor a PortalUser exists — this is the existing
    // "brand new staff signup" case, which must keep auto-provisioning a
    // User and personal Organization exactly as it already does below.
  }

  // organizationId/recipientId (user.id) here are the only ones the
  // notification queries below ever use — both server-resolved, never from
  // client input.
  const { user: currentUser, organizationId } = await getCurrentUserOrganization();

  // A small (at most 6 rows), separately-fetched preference lookup — kept
  // out of the Promise.all below so it can be threaded into both
  // notification queries as excludeTypes, rather than each of them (or this
  // one) re-fetching the same preference set a second time.
  const excludeTypes = await getDisabledInAppTypes(currentUser.id);

  const [organizations, unreadNotificationCount, recentNotificationRows] = await Promise.all([
    getOrganizationSwitcherItems(),
    getUnreadNotificationCount({ organizationId, recipientId: currentUser.id, excludeTypes }),
    getRecentNotifications({
      organizationId,
      recipientId: currentUser.id,
      limit: RECENT_NOTIFICATIONS_LIMIT,
      excludeTypes,
    }),
  ]);

  const recentNotifications: NotificationBellItem[] = recentNotificationRows.map((row) => ({
    id: row.id,
    ...formatNotification({
      type: row.type,
      metadata: row.metadata,
      entityId: row.entityId,
      createdAt: row.createdAt,
      readAt: row.readAt,
    }),
  }));

  return (
    <div className="flex min-h-screen flex-col bg-gray-50 md:flex-row">
      <Sidebar disablePrefetch={TEST_MODE} />
      {/*
        min-w-0: at the md breakpoint this becomes a flex row item next to
        the now-fixed-width Sidebar. Flex items default to `min-width:
        auto`, so without this override the item refuses to shrink below
        its content's intrinsic width — including a wide Table's own
        `overflow-x-auto` wrapper, which can only actually clip/scroll
        once its ancestor chain has somewhere to shrink to. Same root
        cause class as header.tsx's own min-w-0 fix (see that file).
      */}
      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          email={user.email ?? ""}
          organizations={organizations}
          unreadNotificationCount={unreadNotificationCount}
          recentNotifications={recentNotifications}
        />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
