import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { getOptionalPortalUser } from "@/lib/current-portal-user";
import { PortalNav } from "@/components/client-portal/portal-nav";
import { portalSignOut } from "./actions";

// This layout only wraps /portal itself (this route sits in the (app)
// route group nested inside app/portal/ specifically so that /portal/login
// — a sibling, NOT a child of this group — never inherits this guard; a
// portal/layout.tsx placed directly at app/portal/ would also wrap
// /portal/login, and an unauthenticated visitor to the login page would
// bounce straight back into its own redirect.
export default async function PortalAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const identity = await getOptionalPortalUser();

  if (!identity) {
    const supabase = await createClient();
    const {
      data: { user: authUser },
    } = await supabase.auth.getUser();

    if (!authUser) {
      redirect("/portal/login?redirectTo=/portal");
    }

    // A session exists but there's no usable PortalUser for it. If this
    // identity is actually staff, send them to their real home instead of
    // a portal login they could never use — never auto-create anything
    // for them here either way.
    const hasMembership = await prisma.membership.findFirst({
      where: { userId: authUser.id },
      select: { id: true },
    });
    if (hasMembership) {
      redirect("/dashboard");
    }

    redirect("/portal/login");
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div>
            <p className="text-xs font-medium tracking-wide text-gray-500 uppercase">
              Client Portal
            </p>
            <p className="text-sm font-semibold text-gray-900">{identity.client.name}</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right text-sm">
              <p className="font-medium text-gray-900">{identity.portalUser.name}</p>
              <p className="text-xs text-gray-500">{identity.portalUser.email}</p>
            </div>
            <form action={portalSignOut}>
              <button
                type="submit"
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
        <div className="mx-auto max-w-5xl">
          <PortalNav />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
