import { getCurrentMembership } from "@/lib/current-user";
import { prisma } from "@/lib/prisma";
import { Role } from "@/generated/prisma/enums";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableHead,
  TableHeaderCell,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { CopyLinkButton } from "@/components/team/copy-link-button";
import { InviteForm } from "@/components/team/invite-form";
import { ResendInvitationForm } from "@/components/team/resend-invitation-form";
import { CancelInvitationButton } from "@/components/team/cancel-invitation-button";
import { RoleSelect } from "@/components/team/role-select";
import { TransferOwnershipButton } from "@/components/team/transfer-ownership-button";
import { RemoveMemberButton } from "@/components/team/remove-member-button";
import { LeaveOrganizationButton } from "@/components/team/leave-organization-button";
import {
  inviteMemberAction,
  resendInvitationAction,
  cancelInvitationAction,
  changeRoleAction,
  removeMemberAction,
  leaveOrganizationAction,
} from "./actions";

export default async function TeamPage() {
  const { user, organizationId, membership } = await getCurrentMembership();

  const [memberships, invitations] = await Promise.all([
    prisma.membership.findMany({
      where: { organizationId },
      // Role's declaration order in the schema (OWNER, ADMIN, MEMBER) is
      // also its Postgres enum ordinal order, so sorting ascending on the
      // enum column alone already yields OWNER -> ADMIN -> MEMBER.
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
      include: { user: { select: { name: true, email: true } } },
    }),
    prisma.invitation.findMany({
      where: { organizationId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      include: { invitedBy: { select: { name: true, email: true } } },
    }),
  ]);

  const canManage = membership.role === Role.OWNER || membership.role === Role.ADMIN;
  const isOwner = membership.role === Role.OWNER;

  return (
    <div className="space-y-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
            Team
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            Manage who has access to your organization.
          </p>
        </div>
        <LeaveOrganizationButton
          action={leaveOrganizationAction}
          disabled={isOwner}
          disabledReason={
            isOwner
              ? "You're the only owner — transfer ownership to someone else first."
              : undefined
          }
        />
      </div>

      <section>
        <h2 className="text-lg font-semibold tracking-tight text-gray-900">
          Members
        </h2>
        <Table>
          <TableHead>
            <tr>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Email</TableHeaderCell>
              <TableHeaderCell>Role</TableHeaderCell>
              <TableHeaderCell>Joined</TableHeaderCell>
              {isOwner && <TableHeaderCell align="right">Actions</TableHeaderCell>}
            </tr>
          </TableHead>
          <TableBody>
            {memberships.map((m) => {
              const isSelf = m.userId === user.id;
              return (
                <TableRow key={m.id}>
                  <TableCell emphasis>
                    {m.user.name}
                    {isSelf && (
                      <span className="ml-2 text-xs font-normal text-gray-500">
                        (You)
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{m.user.email}</TableCell>
                  <TableCell>
                    {isOwner && !isSelf ? (
                      <RoleSelect
                        membershipId={m.id}
                        currentRole={m.role as "ADMIN" | "MEMBER"}
                        action={changeRoleAction}
                      />
                    ) : (
                      <StatusBadge status={m.role} />
                    )}
                  </TableCell>
                  <TableCell>{m.createdAt.toLocaleDateString()}</TableCell>
                  {isOwner && (
                    <TableCell align="right">
                      {!isSelf && (
                        <div className="flex items-center justify-end gap-4">
                          <TransferOwnershipButton
                            memberName={m.user.name}
                            onConfirm={changeRoleAction.bind(null, m.id, Role.OWNER)}
                          />
                          <RemoveMemberButton
                            action={removeMemberAction.bind(null, m.id)}
                            memberName={m.user.name}
                          />
                        </div>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>

      <section>
        <h2 className="text-lg font-semibold tracking-tight text-gray-900">
          Pending invitations
        </h2>
        {invitations.length === 0 ? (
          <EmptyState
            title="No pending invitations"
            description="Invite someone below to add them to your organization."
          />
        ) : (
          <Table>
            <TableHead>
              <tr>
                <TableHeaderCell>Email</TableHeaderCell>
                <TableHeaderCell>Role</TableHeaderCell>
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
                    <StatusBadge status={invitation.role} />
                  </TableCell>
                  <TableCell>
                    {invitation.invitedBy?.name ??
                      invitation.invitedBy?.email ??
                      "—"}
                  </TableCell>
                  <TableCell>{invitation.expiresAt.toLocaleDateString()}</TableCell>
                  <TableCell align="right">
                    {canManage ? (
                      <div className="flex items-center justify-end gap-4">
                        <ResendInvitationForm
                          action={resendInvitationAction.bind(null, invitation.id)}
                          initialToken={invitation.token}
                        />
                        <CancelInvitationButton
                          action={cancelInvitationAction.bind(null, invitation.id)}
                          email={invitation.email}
                        />
                      </div>
                    ) : (
                      <CopyLinkButton token={invitation.token} />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      {canManage && (
        <section>
          <h2 className="text-lg font-semibold tracking-tight text-gray-900">
            Invite a member
          </h2>
          <div className="mt-4 max-w-md rounded-lg border border-gray-200 bg-white p-6">
            <InviteForm action={inviteMemberAction} />
          </div>
        </section>
      )}
    </div>
  );
}
