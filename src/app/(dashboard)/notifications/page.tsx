import Link from "next/link";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { markAllNotificationsReadAction } from "@/app/(dashboard)/actions";
import { getUnreadNotificationCount, getNotificationsPage } from "@/lib/notifications/queries";
import { parseNotificationListParams, buildNotificationWhere } from "@/lib/notifications/list-params";
import { getDisabledInAppTypes } from "@/lib/notifications/preferences";
import { formatNotification } from "@/lib/notifications/format-notification";
import { NotificationListItem } from "@/components/notifications/notification-list-item";
import type { NotificationBellItem } from "@/components/notifications/notification-bell";
import { LoadMoreLink } from "@/components/activity/load-more-link";
import { EmptyState } from "@/components/ui/empty-state";
import type { RawSearchParams } from "@/lib/list-params";

function FilterTab({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 ${
        active ? "bg-black text-white" : "text-gray-700 hover:bg-gray-100"
      }`}
    >
      {label}
    </Link>
  );
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const { user, organizationId } = await getCurrentUserOrganization();
  const resolvedSearchParams = await searchParams;
  const listParams = parseNotificationListParams(resolvedSearchParams);

  // Fetched once, threaded into both queries below — see (dashboard)/
  // layout.tsx's identical reasoning for why this isn't inside the
  // Promise.all (both queries depend on its result).
  const excludeTypes = await getDisabledInAppTypes(user.id);
  const where = buildNotificationWhere(organizationId, user.id, listParams, excludeTypes);

  const [{ rows, nextCursor }, unreadCount] = await Promise.all([
    getNotificationsPage(where),
    getUnreadNotificationCount({ organizationId, recipientId: user.id, excludeTypes }),
  ]);

  const items: NotificationBellItem[] = rows.map((row) => ({
    id: row.id,
    ...formatNotification({
      type: row.type,
      metadata: row.metadata,
      entityId: row.entityId,
      createdAt: row.createdAt,
      readAt: row.readAt,
    }),
  }));

  const activeFilterParams: Record<string, string> = listParams.filter !== "all" ? { filter: listParams.filter } : {};

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Notifications</h1>
      <p className="mt-1 text-sm text-gray-600">Things that affect you across your organization.</p>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Notification filter" className="flex gap-1">
          <FilterTab href="/notifications" label="All" active={listParams.filter === "all"} />
          <FilterTab
            href="/notifications?filter=unread"
            label={unreadCount > 0 ? `Unread (${unreadCount})` : "Unread"}
            active={listParams.filter === "unread"}
          />
        </nav>
        {unreadCount > 0 && (
          <form action={markAllNotificationsReadAction}>
            <button
              type="submit"
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
            >
              Mark all as read
            </button>
          </form>
        )}
      </div>

      {listParams.cursorInvalid && (
        <p role="alert" className="mt-4 text-sm text-amber-700">
          Your previous page link expired — showing the latest notifications instead.
        </p>
      )}

      {items.length === 0 ? (
        <EmptyState
          title={listParams.filter === "unread" ? "You're all caught up." : "No notifications yet."}
          description={
            listParams.filter === "unread"
              ? "New notifications will show up here."
              : "Actions that affect you will show up here."
          }
        />
      ) : (
        <ul className="mt-6 divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
          {items.map((item) => (
            <NotificationListItem key={item.id} item={item} />
          ))}
        </ul>
      )}

      {nextCursor && (
        <div className="mt-6 flex justify-center">
          <LoadMoreLink basePath="/notifications" params={activeFilterParams} cursor={nextCursor} />
        </div>
      )}
    </div>
  );
}
