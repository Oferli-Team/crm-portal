import type { ReactNode } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { StatusBadge } from "@/components/ui/status-badge";
import { AcceptInvitationForm } from "@/components/invite/accept-invitation-form";
import { acceptInvitationAction, signOutForInviteAction } from "./actions";

function InviteCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight text-gray-900">
          {title}
        </h1>
        {children}
      </div>
    </main>
  );
}

function isExpired(expiresAt: Date): boolean {
  return expiresAt.getTime() <= Date.now();
}

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const invitation = await prisma.invitation.findUnique({
    where: { token },
    include: {
      organization: { select: { name: true } },
      invitedBy: { select: { name: true, email: true } },
    },
  });

  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  // Not found and REVOKED share one generic message — a valid-looking
  // token for a revoked invitation must be indistinguishable from a token
  // that never existed at all.
  if (!invitation || invitation.status === "REVOKED") {
    return (
      <InviteCard title="Invitation not found">
        <p className="text-sm text-gray-600">
          Invitation not found or no longer available.
        </p>
      </InviteCard>
    );
  }

  if (invitation.status === "ACCEPTED") {
    let alreadyMember = false;
    if (authUser) {
      const membership = await prisma.membership.findUnique({
        where: {
          userId_organizationId: { userId: authUser.id, organizationId: invitation.organizationId },
        },
        select: { id: true },
      });
      alreadyMember = !!membership;
    }

    return (
      <InviteCard title="Invitation already accepted">
        <p className="text-sm text-gray-600">
          This invitation to join {invitation.organization.name} has already
          been accepted.
        </p>
        {alreadyMember && (
          <Link
            href="/dashboard"
            className="mt-4 inline-block rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
          >
            Go to dashboard
          </Link>
        )}
      </InviteCard>
    );
  }

  // PENDING but past its expiry is treated the same as an explicit EXPIRED
  // status for display purposes — no write happens on this GET, so a
  // crawler or link-preview bot hitting this page can never mutate data.
  if (invitation.status === "EXPIRED" || isExpired(invitation.expiresAt)) {
    return (
      <InviteCard title="Invitation expired">
        <p className="text-sm text-gray-600">This invitation has expired.</p>
      </InviteCard>
    );
  }

  const redirectTarget = `/invite/${token}`;
  const normalizedInviteEmail = invitation.email.trim().toLowerCase();
  const normalizedUserEmail = authUser?.email?.trim().toLowerCase() ?? null;
  const emailMatches = normalizedUserEmail !== null && normalizedUserEmail === normalizedInviteEmail;

  return (
    <InviteCard title="You're invited">
      <div className="space-y-2 text-sm text-gray-600">
        <p>
          You&apos;ve been invited to join{" "}
          <span className="font-medium text-gray-900">
            {invitation.organization.name}
          </span>
          .
        </p>
        <p className="flex items-center gap-2">
          <span>Role:</span>
          <StatusBadge status={invitation.role} />
        </p>
        <p>
          Invited email:{" "}
          <span className="font-medium text-gray-900">{invitation.email}</span>
        </p>
        {invitation.invitedBy && (
          <p>
            Invited by:{" "}
            <span className="font-medium text-gray-900">
              {invitation.invitedBy.name ?? invitation.invitedBy.email}
            </span>
          </p>
        )}
        <p>Expires: {invitation.expiresAt.toLocaleDateString()}</p>
      </div>

      <div className="mt-6">
        {!authUser && (
          <div className="flex gap-3">
            <Link
              href={`/login?redirectTo=${encodeURIComponent(redirectTarget)}`}
              className="flex-1 rounded-md bg-black px-4 py-2 text-center text-sm font-medium text-white transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
            >
              Log in
            </Link>
            <Link
              href={`/signup?redirectTo=${encodeURIComponent(redirectTarget)}`}
              className="flex-1 rounded-md border border-gray-300 px-4 py-2 text-center text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
            >
              Sign up
            </Link>
          </div>
        )}

        {authUser && !emailMatches && (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              This invitation was sent to{" "}
              <span className="font-medium text-gray-900">
                {invitation.email}
              </span>
              , but you&apos;re signed in as{" "}
              <span className="font-medium text-gray-900">{authUser.email}</span>
              .
            </p>
            <form action={signOutForInviteAction.bind(null, token)}>
              <button
                type="submit"
                className="w-full rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
              >
                Sign out and log in with the right account
              </button>
            </form>
          </div>
        )}

        {authUser && emailMatches && (
          <AcceptInvitationForm action={acceptInvitationAction.bind(null, token)} />
        )}
      </div>
    </InviteCard>
  );
}
