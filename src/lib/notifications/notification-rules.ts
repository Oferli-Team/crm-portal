import type { Prisma } from "@/generated/prisma/client";
import type { ActivityAction, ActivityEntityType, NotificationType } from "@/generated/prisma/enums";
import {
  buildRoleChangedNotificationMetadata,
  buildOwnershipTransferredNotificationMetadata,
  buildMemberRemovedNotificationMetadata,
  buildInvitationAcceptedNotificationMetadata,
  buildPortalInvitationAcceptedNotificationMetadata,
  buildInvoiceStatusChangedNotificationMetadata,
  buildMentionedNotificationMetadata,
} from "./notification-metadata";

/**
 * Raw IDs needed to resolve a Notification's recipient(s) — never persisted
 * to Activity.metadata (which only ever holds human-readable names/emails,
 * see src/lib/activity/*-metadata.ts) and never rendered anywhere itself.
 * previousOwnerId is kept for documentation even though, in every current
 * OWNERSHIP_TRANSFERRED code path, it always equals the actor and is
 * therefore dropped by the universal actor-exclusion rule in
 * dispatch-notifications.ts.
 *
 * mentionedUserIds (Comments & Mentions Stage 3): already fully validated
 * by the caller before createActivity is ever invoked — real users, real
 * current Membership in this Activity's own organizationId, actor already
 * excluded, deduped, capped at MAX_MENTIONS_PER_COMMENT (src/lib/comments/
 * mentions.ts). For a create, this is every valid mention in the comment;
 * for an edit, only the newly-added ones (src/lib/comments §5/§7) — never
 * removed or unchanged mentions, which must never re-notify.
 *
 * parentEntityId (Comments & Mentions Stage 4): the Project/Task id a
 * MENTIONED comment belongs to — resolveCommentTarget's already-verified
 * result, never a client-supplied value. Exists solely so MENTIONED's own
 * buildMetadata can carry it into the Notification's metadata for deep-
 * linking; deliberately never written to Activity.metadata (see comment-
 * metadata.ts's own "never IDs" discipline, which this doesn't change).
 */
export type NotificationContext = {
  affectedUserId?: string;
  invitedById?: string | null;
  previousOwnerId?: string;
  newOwnerId?: string;
  mentionedUserIds?: string[];
  parentEntityId?: string;
};

/** The minimal shape dispatchNotificationsForActivity needs from a just-created Activity row. */
export type CreatedActivity = {
  id: string;
  organizationId: string;
  actorId: string | null;
  entityType: ActivityEntityType;
  entityId: string;
  action: ActivityAction;
  metadata: Prisma.JsonValue;
};

export type NotificationRule = {
  type: NotificationType;
  /** Candidate recipient User IDs. Actor-exclusion, dedup, and existence
   * filtering happen once, uniformly, in dispatch-notifications.ts — a rule
   * only computes who is *plausibly* affected. Takes tx because
   * INVOICE_STATUS_CHANGED's recipients (every OWNER/ADMIN in the org) can
   * only be resolved with a Membership query, not from context alone. */
  resolveRecipients: (
    tx: Prisma.TransactionClient,
    activity: CreatedActivity,
    context: NotificationContext | undefined,
  ) => Promise<string[]>;
  /** context is optional to implement — every existing rule ignores it; only MENTIONED reads it (for parentEntityId). */
  buildMetadata: (activity: CreatedActivity, context: NotificationContext | undefined) => Prisma.InputJsonValue;
};

const ROLE_CHANGED: NotificationRule = {
  type: "ROLE_CHANGED",
  resolveRecipients: async (_tx, _activity, context) =>
    context?.affectedUserId ? [context.affectedUserId] : [],
  buildMetadata: (activity) => buildRoleChangedNotificationMetadata(activity.metadata),
};

const OWNERSHIP_TRANSFERRED: NotificationRule = {
  type: "OWNERSHIP_TRANSFERRED",
  // previousOwnerId is deliberately not included here: in every current
  // code path (changeRoleAction) it's always the actor transferring their
  // own ownership away, and dispatch-notifications.ts already excludes the
  // actor from every rule's recipients. Only the new owner is notified.
  resolveRecipients: async (_tx, _activity, context) =>
    context?.newOwnerId ? [context.newOwnerId] : [],
  buildMetadata: (activity) => buildOwnershipTransferredNotificationMetadata(activity.metadata),
};

const MEMBER_REMOVED: NotificationRule = {
  type: "MEMBER_REMOVED",
  resolveRecipients: async (_tx, _activity, context) =>
    context?.affectedUserId ? [context.affectedUserId] : [],
  buildMetadata: (activity) => buildMemberRemovedNotificationMetadata(activity.metadata),
};

const INVITATION_ACCEPTED: NotificationRule = {
  type: "INVITATION_ACCEPTED",
  resolveRecipients: async (_tx, _activity, context) =>
    context?.invitedById ? [context.invitedById] : [],
  buildMetadata: (activity) => buildInvitationAcceptedNotificationMetadata(activity.metadata),
};

const PORTAL_INVITATION_ACCEPTED: NotificationRule = {
  type: "PORTAL_INVITATION_ACCEPTED",
  resolveRecipients: async (_tx, _activity, context) =>
    context?.invitedById ? [context.invitedById] : [],
  buildMetadata: (activity) => buildPortalInvitationAcceptedNotificationMetadata(activity.metadata),
};

const INVOICE_STATUS_CHANGED: NotificationRule = {
  type: "INVOICE_STATUS_CHANGED",
  // docs/notifications-architecture.md §4: "Every OWNER/ADMIN in the org" —
  // the one genuine one-to-many rule among the approved MVP set. Resolved
  // via a Membership query rather than context, since it depends only on
  // org membership already known at fan-out time.
  resolveRecipients: async (tx, activity) => {
    const members = await tx.membership.findMany({
      where: { organizationId: activity.organizationId, role: { in: ["OWNER", "ADMIN"] } },
      select: { userId: true },
    });
    return members.map((m) => m.userId);
  },
  buildMetadata: (activity) => buildInvoiceStatusChangedNotificationMetadata(activity.metadata),
};

/**
 * Comments & Mentions Stage 3 (docs/comments-architecture.md §5). The only
 * Comment-related event that ever notifies anyone — a bare comment with no
 * `@mention` never reaches this rule at all (createCommentForEntity only
 * passes `mentionedUserIds` in NotificationContext when there is at least
 * one). Recipients are simply the already-validated list the caller
 * computed (see NotificationContext's own doc comment above) — no further
 * Membership query needed here, unlike INVOICE_STATUS_CHANGED, since the
 * caller already resolved "which of these ids are real, current members of
 * this organization" before createActivity was ever called. The universal
 * actor-exclusion/dedup/existence-check dispatch-notifications.ts applies
 * to every rule still runs on top of this — redundant here by
 * construction, but harmless defense in depth, not load-bearing.
 */
const MENTIONED: NotificationRule = {
  type: "MENTIONED",
  resolveRecipients: async (_tx, _activity, context) => context?.mentionedUserIds ?? [],
  buildMetadata: (activity, context) => buildMentionedNotificationMetadata(activity.metadata, context),
};

/**
 * Keyed by entityType then action — deliberately only the approved MVP
 * pairs. Every other (entityType, action) combination (CREATED/UPDATED/
 * DELETED of regular entities, attachments, invitation SENT/RESENT/
 * CANCELED, MEMBER_LEFT, Activity reads, login/logout, portal views/
 * downloads) has no entry and resolves to undefined — a deliberate no-op,
 * not an oversight. COMMENT/DELETED has no entry either — deleting a
 * comment never notifies anyone (docs/comments-architecture.md §5).
 */
const RULES: Partial<Record<ActivityEntityType, Partial<Record<ActivityAction, NotificationRule>>>> = {
  MEMBERSHIP: {
    ROLE_CHANGED,
    OWNERSHIP_TRANSFERRED,
    MEMBER_REMOVED,
  },
  INVITATION: {
    INVITATION_ACCEPTED,
  },
  PORTAL_USER: {
    PORTAL_INVITATION_ACCEPTED,
  },
  INVOICE: {
    STATUS_CHANGED: INVOICE_STATUS_CHANGED,
  },
  COMMENT: {
    CREATED: MENTIONED,
    UPDATED: MENTIONED,
  },
};

export function resolveNotificationRule(
  entityType: ActivityEntityType,
  action: ActivityAction,
): NotificationRule | undefined {
  return RULES[entityType]?.[action];
}
