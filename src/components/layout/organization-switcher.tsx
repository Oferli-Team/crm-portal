"use client";

import { useRef, useTransition } from "react";
import { StatusBadge } from "@/components/ui/status-badge";
import { SpinnerIcon } from "@/components/ui/icons";
import { useToast } from "@/components/toast/toast-provider";
import type { OrganizationSwitcherItem } from "@/lib/current-user";

/**
 * Native <details>/<summary> disclosure — same reasoning as ConfirmDialog's
 * native <dialog>: gives a dependency-free popover with no extra library.
 */
export function OrganizationSwitcher({
  organizations,
  action,
}: {
  organizations: OrganizationSwitcherItem[];
  /** switchOrganizationAction — redirects on success, throws on failure. */
  action: (organizationId: string) => Promise<void>;
}) {
  const active = organizations.find((org) => org.isActive);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [isPending, startTransition] = useTransition();
  const { showToast } = useToast();

  if (!active) return null;

  if (organizations.length === 1) {
    return (
      <div className="flex min-w-0 max-w-[10rem] flex-col leading-tight sm:max-w-[16rem]">
        <span className="truncate text-sm font-medium text-gray-900" title={active.name}>
          {active.name}
        </span>
        <span className="truncate text-xs text-gray-500" title={active.slug}>
          {active.slug}
        </span>
      </div>
    );
  }

  function handleSelect(organizationId: string) {
    if (isPending || organizationId === active!.organizationId) return;
    detailsRef.current?.removeAttribute("open");
    startTransition(async () => {
      try {
        // On success this redirects (and never returns) — only the error
        // path needs handling here.
        await action(organizationId);
      } catch (err) {
        showToast(
          err instanceof Error ? err.message : "Failed to switch organization.",
          "error",
        );
      }
    });
  }

  return (
    <details ref={detailsRef} className="group relative">
      <summary
        className="flex max-w-[12rem] cursor-pointer list-none items-center gap-2 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 disabled:cursor-not-allowed [&::-webkit-details-marker]:hidden"
        aria-disabled={isPending}
      >
        {isPending ? (
          <SpinnerIcon className="h-4 w-4 shrink-0" />
        ) : (
          <span aria-hidden className="text-gray-400">
            ▾
          </span>
        )}
        <span className="truncate">{active.name}</span>
      </summary>
      <div className="absolute left-0 z-20 mt-2 w-64 rounded-md border border-gray-200 bg-white py-1 shadow-lg">
        {organizations.map((org) => (
          <button
            key={org.organizationId}
            type="button"
            disabled={isPending}
            onClick={() => handleSelect(org.organizationId)}
            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 truncate font-medium text-gray-900">
                {org.isActive && (
                  <span aria-hidden className="text-black">
                    ✓
                  </span>
                )}
                <span className="truncate">{org.name}</span>
              </span>
              <span className="block truncate text-xs text-gray-500">{org.slug}</span>
            </span>
            <span className="shrink-0">
              <StatusBadge status={org.role} />
            </span>
          </button>
        ))}
      </div>
    </details>
  );
}
