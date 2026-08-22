"use client";

import { useTransition } from "react";
import Link from "next/link";
import { markNotificationReadAction } from "@/app/(dashboard)/actions";
import { relativeTime } from "@/lib/notifications/relative-time";
import type { NotificationBellItem } from "./notification-bell";

/**
 * The /notifications page's row — same NotificationBellItem view model and
 * the same single formatter as the dropdown's NotificationItem, just a
 * roomier full-page presentation with no dropdown to close afterward. Owns
 * its own transition (each row marks itself read independently), unlike the
 * dropdown where one transition is shared across the whole list.
 */
export function NotificationListItem({ item }: { item: NotificationBellItem }) {
  const [isPending, startTransition] = useTransition();

  function handleMarkRead() {
    startTransition(async () => {
      await markNotificationReadAction(item.id);
    });
  }

  const body = (
    <>
      <p className={`text-sm ${item.isUnread ? "font-semibold text-gray-900" : "text-gray-700"}`}>
        {item.title}
        {item.isUnread && (
          <>
            <span
              aria-hidden="true"
              className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-blue-600 align-middle"
            />
            <span className="sr-only"> (unread)</span>
          </>
        )}
      </p>
      {item.detail && <p className="mt-0.5 text-sm text-gray-500">{item.detail}</p>}
      <time
        dateTime={item.timestamp.toISOString()}
        title={item.timestamp.toLocaleString()}
        className="mt-1 block text-xs text-gray-400"
      >
        {relativeTime(item.timestamp)}
      </time>
    </>
  );

  // Same Variant A as the dropdown: an unread item with a safe link marks
  // itself read and navigates in the same click. No safe link (see
  // format-notification.ts's buildLink allowlist) → a standalone button,
  // never a guessed URL.
  if (item.link) {
    return (
      <li className={item.isUnread ? "bg-blue-50/60" : ""}>
        <Link
          href={item.link}
          onClick={() => {
            if (item.isUnread) handleMarkRead();
          }}
          className="block p-4 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-black"
        >
          {body}
        </Link>
      </li>
    );
  }

  return (
    <li className={`p-4 ${item.isUnread ? "bg-blue-50/60" : ""}`}>
      {body}
      {item.isUnread && (
        <button
          type="button"
          disabled={isPending}
          onClick={handleMarkRead}
          className="mt-2 rounded text-xs font-medium text-gray-600 transition-colors hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Mark as read
        </button>
      )}
    </li>
  );
}
