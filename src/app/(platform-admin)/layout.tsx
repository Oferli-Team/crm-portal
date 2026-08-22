import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/platform-admin/authorization";

const links = [
  { href: "/platform-admin", label: "Dashboard" },
  { href: "/platform-admin/organizations", label: "Organizations" },
  { href: "/platform-admin/users", label: "Users" },
  { href: "/platform-admin/configuration", label: "Configuration" },
];

/**
 * Sale-Ready Phase C. Deliberately its own route group, not nested under
 * (dashboard) — this guard has no concept of "active organization" and
 * must never gain one (see requirePlatformAdmin's own doc comment). Never
 * imports Sidebar/Header/OrganizationSwitcher: those are tenant concepts
 * with no meaning for a cross-organization tool.
 *
 * requirePlatformAdmin() runs exactly once, here, before any child page —
 * same "guard lives in the layout, not repeated per-page" pattern
 * (dashboard)/layout.tsx already establishes for its own portal-identity
 * guard.
 */
export default async function PlatformAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { email } = await requirePlatformAdmin();

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
          {/*
            min-w-0 lets this group actually shrink below its content's
            intrinsic width, and flex-wrap on the nav itself lets the
            links wrap onto a second line once they no longer fit one —
            the same min-w-0 fix layout/header.tsx's own doc comment
            documents (flex items default to `min-width: auto`, which
            otherwise silently blocks any shrinking at all). Found by
            responsive-layout.spec.ts's own app-wide overflow regression
            coverage the moment a 4th nav link (Configuration) made this
            row wider than a 375px viewport.
          */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2">
            <span className="text-sm font-semibold tracking-tight text-gray-900">
              Platform Admin
            </span>
            <nav aria-label="Platform Admin" className="flex flex-wrap gap-4">
              {links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="rounded text-sm text-gray-600 hover:text-gray-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
                >
                  {link.label}
                </Link>
              ))}
            </nav>
          </div>
          <span className="text-xs text-gray-500">{email}</span>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
