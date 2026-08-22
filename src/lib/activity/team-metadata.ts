// Safe metadata builders for Team/Membership/Invitation Activity events.
// Never includes: invitation token, invitation URL, email provider
// responses, auth/session data, or full formData — only names/emails/roles
// that are already visible in the Team page UI.

export type InvitationActivityMetadata = {
  email: string;
  role: string;
  actorName: string;
};

/** Shared shape for INVITATION_SENT, INVITATION_RESENT, INVITATION_CANCELED. */
export function buildInvitationMetadata(
  invitation: { email: string; role: string },
  actorName: string,
): InvitationActivityMetadata {
  return { email: invitation.email, role: invitation.role, actorName };
}

export type InvitationAcceptedMetadata = {
  email: string;
  role: string;
  memberName: string;
  actorName: string;
};

/**
 * INVITATION_ACCEPTED is self-referential — the actor accepting the
 * invitation IS the new member — so memberName and actorName are the same
 * value at the call site, but both are still named explicitly here for
 * consistency with the other Membership event shapes.
 */
export function buildInvitationAcceptedMetadata(
  invitation: { email: string; role: string },
  memberName: string,
  actorName: string,
): InvitationAcceptedMetadata {
  return { email: invitation.email, role: invitation.role, memberName, actorName };
}

export type MembershipActivityMetadata = {
  memberName: string;
  memberEmail: string;
  role: string;
  actorName: string;
};

/** Shared shape for MEMBER_REMOVED and MEMBER_LEFT. */
export function buildMembershipMetadata(
  member: { name: string; email: string },
  role: string,
  actorName: string,
): MembershipActivityMetadata {
  return { memberName: member.name, memberEmail: member.email, role, actorName };
}

export type RoleChangedMetadata = {
  memberName: string;
  memberEmail: string;
  from: string;
  to: string;
  actorName: string;
};

export function buildRoleChangedMetadata(
  member: { name: string; email: string },
  from: string,
  to: string,
  actorName: string,
): RoleChangedMetadata {
  return { memberName: member.name, memberEmail: member.email, from, to, actorName };
}

export type OwnershipTransferredMetadata = {
  previousOwnerName: string;
  newOwnerName: string;
  actorName: string;
};

export function buildOwnershipTransferredMetadata(
  previousOwnerName: string,
  newOwnerName: string,
  actorName: string,
): OwnershipTransferredMetadata {
  return { previousOwnerName, newOwnerName, actorName };
}
