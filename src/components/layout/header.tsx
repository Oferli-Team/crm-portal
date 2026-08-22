import { signOut, switchOrganizationAction } from "@/app/(dashboard)/actions";
import { OrganizationSwitcher } from "@/components/layout/organization-switcher";
import { NotificationBell, type NotificationBellItem } from "@/components/notifications/notification-bell";
import { GlobalSearch } from "@/components/search/global-search";
import type { OrganizationSwitcherItem } from "@/lib/current-user";

export function Header({
  email,
  organizations,
  unreadNotificationCount,
  recentNotifications,
}: {
  email: string;
  organizations: OrganizationSwitcherItem[];
  unreadNotificationCount: number;
  recentNotifications: NotificationBellItem[];
}) {
  const activeOrganizationId = organizations.find((org) => org.isActive)?.organizationId;

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 bg-white px-6 py-4">
      <OrganizationSwitcher organizations={organizations} action={switchOrganizationAction} />
      {/*
        min-w-0 lets this group actually shrink below its content's
        intrinsic width when the header wraps onto its own row on a
        narrow viewport — flex items default to `min-width: auto`, which
        silently blocks any child's `truncate` from ever taking effect
        and was the real cause of the horizontal overflow this fixes
        (the email span below had nowhere to shrink to).
      */}
      <div className="flex min-w-0 items-center gap-4">
        {/*
          key={activeOrganizationId} forces React to fully unmount and
          remount GlobalSearch (discarding its search state) whenever the
          active organization changes — defense-in-depth alongside the
          search dialog's own modal-blocking (see search-dialog.tsx). No
          new prop/fetch needed: `organizations` (already server-resolved
          in (dashboard)/layout.tsx) already carries the active org's id.
        */}
        <GlobalSearch key={activeOrganizationId} />
        <NotificationBell
          initialUnreadCount={unreadNotificationCount}
          initialNotifications={recentNotifications}
        />
        {/*
          min-w-0 + truncate: an unconstrained-width email (real emails
          run well past 30 characters) was the dominant contributor to
          the header's mobile overflow. Full address is still in the DOM
          (screen readers get it unabridged) and in `title` (hover for
          sighted mouse users) — only the visual line is ever shortened.
        */}
        <span className="min-w-0 max-w-[7rem] truncate text-sm text-gray-600 sm:max-w-[16rem]" title={email}>
          {email}
        </span>
        <form action={signOut} className="shrink-0">
          <button
            type="submit"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
