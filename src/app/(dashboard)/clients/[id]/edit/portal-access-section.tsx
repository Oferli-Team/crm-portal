import { prisma } from "@/lib/prisma";
import { Role } from "@/generated/prisma/enums";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableHead,
  TableHeaderCell,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { PortalInviteForm } from "@/components/client-portal/portal-invite-form";
import { PortalCopyLinkButton } from "@/components/client-portal/portal-copy-link-button";
import {
  ResendPortalInvitationForm,
  CancelPortalInvitationButton,
  RemovePortalUserButton,
} from "@/components/client-portal/portal-invitation-actions";
import {
  inviteClientPortalUserAction,
  resendClientInvitationAction,
  cancelClientInvitationAction,
  removePortalUserAction,
} from "./portal-access-actions";

/**
 * Staff-side Client Portal access management, embedded in the Client edit
 * page. Data is fetched fresh here (no caching layer), scoped by clientId
 * alone — the caller (EditClientPage) has already verified this Client
 * belongs to the current organization, so no further organizationId check
 * is needed for the reads below; every mutation still re-verifies it
 * independently in portal-access-actions.ts, since that's the actual
 * security boundary, not this read.
 */
export async function ClientPortalAccessSection({
  clientId,
  role,
}: {
  clientId: string;
  role: Role;
}) {
  const canManage = role === Role.OWNER || role === Role.ADMIN;

  const [portalUsers, invitations] = await Promise.all([
    prisma.portalUser.findMany({
      where: { clientId },
      orderBy: { createdAt: "asc" },
    }),
    prisma.clientInvitation.findMany({
      where: { clientId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      include: { invitedBy: { select: { name: true, email: true } } },
    }),
  ]);

  return (
    <section className="mt-10 border-t border-gray-200 pt-8">
      <h2 className="text-lg font-semibold tracking-tight text-gray-900">
        Client Portal access
      </h2>
      <p className="mt-1 text-sm text-gray-600">
        Invite this client to sign in and view their own portal.
      </p>

      <div className="mt-4">
        <h3 className="text-sm font-medium text-gray-900">Portal users</h3>
        {portalUsers.length === 0 ? (
          <EmptyState
            title="No portal users yet"
            description="Invited contacts appear here once they accept."
          />
        ) : (
          <Table>
            <TableHead>
              <tr>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Email</TableHeaderCell>
                <TableHeaderCell>Since</TableHeaderCell>
                {canManage && <TableHeaderCell align="right">Actions</TableHeaderCell>}
              </tr>
            </TableHead>
            <TableBody>
              {portalUsers.map((portalUser) => (
                <TableRow key={portalUser.id}>
                  <TableCell emphasis>{portalUser.name}</TableCell>
                  <TableCell>{portalUser.email}</TableCell>
                  <TableCell>{portalUser.createdAt.toLocaleDateString()}</TableCell>
                  {canManage && (
                    <TableCell align="right">
                      <RemovePortalUserButton
                        action={removePortalUserAction.bind(null, portalUser.id)}
                        portalUserName={portalUser.name}
                      />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <div className="mt-8">
        <h3 className="text-sm font-medium text-gray-900">Pending invitations</h3>
        {invitations.length === 0 ? (
          <EmptyState
            title="No pending invitations"
            description="Invite a contact below to give them portal access."
          />
        ) : (
          <Table>
            <TableHead>
              <tr>
                <TableHeaderCell>Email</TableHeaderCell>
                <TableHeaderCell>Invited by</TableHeaderCell>
                <TableHeaderCell>Expires</TableHeaderCell>
                <TableHeaderCell align="right">
                  {canManage ? "Actions" : "Link"}
                </TableHeaderCell>
              </tr>
            </TableHead>
            <TableBody>
              {invitations.map((invitation) => (
                <TableRow key={invitation.id}>
                  <TableCell emphasis>{invitation.email}</TableCell>
                  <TableCell>
                    {invitation.invitedBy?.name ?? invitation.invitedBy?.email ?? "—"}
                  </TableCell>
                  <TableCell>{invitation.expiresAt.toLocaleDateString()}</TableCell>
                  <TableCell align="right">
                    {canManage ? (
                      <div className="flex items-center justify-end gap-4">
                        <ResendPortalInvitationForm
                          action={resendClientInvitationAction.bind(null, invitation.id)}
                          initialToken={invitation.token}
                        />
                        <CancelPortalInvitationButton
                          action={cancelClientInvitationAction.bind(null, invitation.id)}
                          email={invitation.email}
                        />
                      </div>
                    ) : (
                      <PortalCopyLinkButton token={invitation.token} />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {canManage && (
        <div className="mt-8 max-w-md">
          <h3 className="text-sm font-medium text-gray-900">Invite a contact</h3>
          <div className="mt-2 rounded-lg border border-gray-200 p-4">
            <PortalInviteForm action={inviteClientPortalUserAction.bind(null, clientId)} />
          </div>
        </div>
      )}
    </section>
  );
}
