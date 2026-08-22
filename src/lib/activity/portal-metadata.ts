// Safe metadata builders for Client Portal (PortalUser/ClientInvitation)
// Activity events. Never includes: invitation token, invitation URL, email
// provider responses, auth/session data, organizationId, or clientId —
// only names/emails already visible in the staff Portal Access UI.

export type PortalInvitationActivityMetadata = {
  email: string;
  clientName: string;
  actorName: string;
};

/** Shared shape for PORTAL_INVITATION_SENT, _RESENT, _CANCELED. */
export function buildPortalInvitationMetadata(
  invitation: { email: string },
  clientName: string,
  actorName: string,
): PortalInvitationActivityMetadata {
  return { email: invitation.email, clientName, actorName };
}

export type PortalInvitationAcceptedMetadata = {
  portalUserName: string;
  portalUserEmail: string;
  clientName: string;
  actorName: string;
};

/**
 * PORTAL_INVITATION_ACCEPTED is self-referential — the PortalUser accepting
 * IS the actor — so portalUserName and actorName are the same value at the
 * call site. actorId itself is always null for this event (a PortalUser is
 * never a valid Activity.actor, which is a relation to the staff User
 * model), so this actorName is what formatActivity falls back to for
 * display.
 */
export function buildPortalInvitationAcceptedMetadata(
  portalUser: { name: string; email: string },
  clientName: string,
  actorName: string,
): PortalInvitationAcceptedMetadata {
  return {
    portalUserName: portalUser.name,
    portalUserEmail: portalUser.email,
    clientName,
    actorName,
  };
}

export type PortalUserRemovedMetadata = {
  portalUserName: string;
  portalUserEmail: string;
  clientName: string;
  actorName: string;
};

export function buildPortalUserRemovedMetadata(
  portalUser: { name: string; email: string },
  clientName: string,
  actorName: string,
): PortalUserRemovedMetadata {
  return {
    portalUserName: portalUser.name,
    portalUserEmail: portalUser.email,
    clientName,
    actorName,
  };
}
