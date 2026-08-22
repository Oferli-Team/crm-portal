import { formatStatusLabel } from "@/lib/format";
import { formatInvoiceStatusLabel } from "@/lib/invoices/status-label";
import type { NotificationType } from "@/generated/prisma/enums";

export type NotificationDisplayModel = {
  title: string;
  detail: string | null;
  timestamp: Date;
  isUnread: boolean;
  /** Allowlisted by type, never built from raw metadata — see resolveNotificationLinkPath. */
  link: string | null;
};

export type NotificationFormatInput = {
  type: NotificationType;
  metadata: unknown;
  entityId: string | null;
  createdAt: Date;
  readAt: Date | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const FALLBACK_TITLE = "Notification received";
const UNKNOWN_ACTOR = "Someone";

type PartialModel = { title: string; detail: string | null };

function buildRoleChanged(metadata: Record<string, unknown>): PartialModel {
  const actorName = str(metadata.actorName) ?? UNKNOWN_ACTOR;
  const from = str(metadata.from);
  const to = str(metadata.to);
  return {
    title: `${actorName} changed your role`,
    detail: from && to ? `${formatStatusLabel(from)} → ${formatStatusLabel(to)}` : null,
  };
}

function buildOwnershipTransferred(metadata: Record<string, unknown>): PartialModel {
  const actorName = str(metadata.actorName) ?? UNKNOWN_ACTOR;
  const previousOwnerName = str(metadata.previousOwnerName);
  const newOwnerName = str(metadata.newOwnerName);
  return {
    title: `${actorName} transferred ownership to you`,
    detail: previousOwnerName && newOwnerName ? `${previousOwnerName} → ${newOwnerName}` : null,
  };
}

function buildMemberRemoved(metadata: Record<string, unknown>): PartialModel {
  const actorName = str(metadata.actorName) ?? UNKNOWN_ACTOR;
  return { title: `${actorName} removed you from the organization`, detail: null };
}

function buildInvitationAccepted(metadata: Record<string, unknown>): PartialModel {
  const acceptedUserName = str(metadata.acceptedUserName) ?? UNKNOWN_ACTOR;
  const email = str(metadata.email);
  const role = str(metadata.role);
  return {
    title: `${acceptedUserName} accepted your invitation`,
    detail: email && role ? `${email} · ${formatStatusLabel(role)}` : null,
  };
}

function buildPortalInvitationAccepted(metadata: Record<string, unknown>): PartialModel {
  const acceptedUserName = str(metadata.acceptedUserName) ?? UNKNOWN_ACTOR;
  const clientName = str(metadata.clientName);
  const email = str(metadata.email);
  return {
    title: `${acceptedUserName} accepted Client Portal access`,
    detail: clientName && email ? `${clientName} · ${email}` : null,
  };
}

/**
 * invoiceNumber is the one field this type can't do without — with no
 * invoice to name, "changed invoice status" is meaningless, so this falls
 * back to the generic title entirely rather than rendering a half sentence.
 */
function buildInvoiceStatusChanged(metadata: Record<string, unknown>): PartialModel | null {
  const invoiceNumber = str(metadata.invoiceNumber);
  if (!invoiceNumber) return null;

  const actorName = str(metadata.actorName) ?? UNKNOWN_ACTOR;
  const from = str(metadata.from);
  const to = str(metadata.to);
  const projectName = str(metadata.projectName);
  const statusChange = from && to ? `${formatInvoiceStatusLabel(from)} → ${formatInvoiceStatusLabel(to)}` : null;

  return {
    title: `${actorName} changed invoice ${invoiceNumber} status`,
    detail: statusChange ? (projectName ? `${statusChange} · ${projectName}` : statusChange) : null,
  };
}

/**
 * Comments & Mentions Stage 3 (docs/comments-architecture.md §5/§6).
 * commentPreview is already a bounded, whitespace-collapsed plain-text
 * string (src/lib/comments/preview.ts) — rendered as-is, never re-escaped
 * or reinterpreted as markup.
 */
function buildMentioned(metadata: Record<string, unknown>): PartialModel {
  const actorName = str(metadata.actorName) ?? UNKNOWN_ACTOR;
  const commentPreview = str(metadata.commentPreview);
  return {
    title: `${actorName} mentioned you in a comment`,
    detail: commentPreview,
  };
}

/**
 * Billing & Subscriptions Stage 4 (docs/billing-architecture.md §17).
 * metadata.planName is the one field every billing notification always
 * carries (src/lib/billing/notify.ts's own BillingNotificationMetadata) —
 * never a providerCustomerId/providerSubscriptionId, matching this
 * module's own "never render raw metadata" discipline.
 */
function buildSubscriptionActivated(metadata: Record<string, unknown>): PartialModel | null {
  const planName = str(metadata.planName);
  if (!planName) return null;
  return { title: `Your ${planName} plan is now active`, detail: null };
}

function buildPaymentFailed(metadata: Record<string, unknown>): PartialModel {
  const planName = str(metadata.planName);
  return {
    title: "A payment failed",
    detail: planName ? `${planName} plan — update your payment method to avoid losing access.` : null,
  };
}

function buildSubscriptionCanceled(metadata: Record<string, unknown>): PartialModel {
  const planName = str(metadata.planName);
  return {
    title: "Your subscription was canceled",
    detail: planName ? `${planName} plan` : null,
  };
}

function buildPlanChanged(metadata: Record<string, unknown>): PartialModel | null {
  const planName = str(metadata.planName);
  if (!planName) return null;
  const previousPlanName = str(metadata.previousPlanName);
  return {
    title: `Your plan changed to ${planName}`,
    detail: previousPlanName ? `${previousPlanName} → ${planName}` : null,
  };
}

function buildModel(type: NotificationType, metadata: Record<string, unknown>): PartialModel | null {
  switch (type) {
    case "ROLE_CHANGED":
      return buildRoleChanged(metadata);
    case "OWNERSHIP_TRANSFERRED":
      return buildOwnershipTransferred(metadata);
    case "MEMBER_REMOVED":
      return buildMemberRemoved(metadata);
    case "INVITATION_ACCEPTED":
      return buildInvitationAccepted(metadata);
    case "PORTAL_INVITATION_ACCEPTED":
      return buildPortalInvitationAccepted(metadata);
    case "INVOICE_STATUS_CHANGED":
      return buildInvoiceStatusChanged(metadata);
    case "MENTIONED":
      return buildMentioned(metadata);
    case "SUBSCRIPTION_ACTIVATED":
      return buildSubscriptionActivated(metadata);
    case "PAYMENT_FAILED":
      return buildPaymentFailed(metadata);
    case "SUBSCRIPTION_CANCELED":
      return buildSubscriptionCanceled(metadata);
    case "PLAN_CHANGED":
      return buildPlanChanged(metadata);
    default:
      // Defensive only — a future enum addition without a matching case
      // here must degrade to the generic fallback, never throw.
      return null;
  }
}

// Comments & Mentions Stage 4 — the two (and only two) parent routes a
// MENTIONED notification can ever link into, keyed by the exact
// CommentEntityType string stored in Notification.metadata.parentEntityType
// (itself copied verbatim from Activity metadata, which src/lib/comments/
// resolve-target.ts only ever sets to "PROJECT" or "TASK"). Anything else
// (a malformed/unexpected value) falls through to no link at all.
const MENTIONED_PARENT_ROUTES: Record<string, string> = {
  PROJECT: "projects",
  TASK: "tasks",
};

/**
 * Stage 4's deep-link decision: Notification.entityId for a MENTIONED
 * notification is (and stays) the Comment's own id — copied verbatim by
 * dispatch-notifications.ts from the source Activity row, which this
 * change does not touch — so it's exactly what the `#comment-{id}`
 * fragment needs. The *path* needs the parent Project/Task's own id,
 * which never lived in Activity.metadata (comment-metadata.ts's own
 * "never IDs" rule) and instead flows in only through this one
 * notification's own metadata (parentEntityId — see notification-
 * metadata.ts's buildMentionedNotificationMetadata for the full
 * reasoning on why this specific exception is safe). Both
 * parentEntityType and parentEntityId are validated here — an unexpected
 * parentEntityType or a missing parentEntityId degrades to no link,
 * never a guessed or partially-built URL.
 */
function resolveMentionedLinkPath(commentId: string | null, metadata: unknown): string | null {
  if (!commentId) return null;
  const m = isRecord(metadata) ? metadata : {};
  const parentEntityId = str(m.parentEntityId);
  if (!parentEntityId) return null;
  const routeSegment = MENTIONED_PARENT_ROUTES[str(m.parentEntityType) ?? ""];
  if (!routeSegment) return null;
  return `/${routeSegment}/${parentEntityId}/edit#comment-${commentId}`;
}

/**
 * Allowlisted per type — never built from arbitrary metadata. MEMBERSHIP/
 * INVITATION notifications point at /team (a list page, not a per-id
 * route, so there's nothing to 404 on). INVOICE_STATUS_CHANGED points at
 * the real /invoices/[id]/edit route, which already renders its own
 * notFound() for a deleted invoice — no link is safer than a broken one,
 * but this one degrades gracefully instead of needing a live check here.
 * PORTAL_INVITATION_ACCEPTED gets no link: its Notification.metadata only
 * ever carries clientName (a display string), never a clientId, so there is
 * no reliable id to build /clients/[id]/edit from. MENTIONED is the one
 * type whose link needs metadata beyond entityId — see
 * resolveMentionedLinkPath above.
 *
 * Exported so the email formatter (src/lib/notifications/email/format-
 * notification-email.ts) builds its CTA from this exact same allowlist
 * instead of a second NotificationType switch — one link-path decision,
 * two channels rendering it differently (a relative in-app href here, an
 * absolute APP_BASE_URL-prefixed URL there).
 */
export function resolveNotificationLinkPath(
  type: NotificationType,
  entityId: string | null,
  metadata?: unknown,
): string | null {
  switch (type) {
    case "ROLE_CHANGED":
    case "OWNERSHIP_TRANSFERRED":
    case "MEMBER_REMOVED":
    case "INVITATION_ACCEPTED":
      return "/team";
    case "INVOICE_STATUS_CHANGED":
      return entityId ? `/invoices/${entityId}/edit` : null;
    case "MENTIONED":
      return resolveMentionedLinkPath(entityId, metadata);
    // Billing & Subscriptions Stage 4 — every billing notification links
    // to the one page that shows current plan/status/usage; there is no
    // per-id entity to deep-link into (a Subscription has no its own
    // page).
    case "SUBSCRIPTION_ACTIVATED":
    case "PAYMENT_FAILED":
    case "SUBSCRIPTION_CANCELED":
    case "PLAN_CHANGED":
      return "/settings/billing";
    case "PORTAL_INVITATION_ACCEPTED":
    default:
      return null;
  }
}

/**
 * Converts a raw Notification row into a safe display model. Never throws
 * and never renders metadata directly — every field is read defensively,
 * and anything missing/malformed falls back to a neutral "Notification
 * received" line with no link, rather than crashing the dropdown.
 */
export function formatNotification(input: NotificationFormatInput): NotificationDisplayModel {
  const metadata = isRecord(input.metadata) ? input.metadata : {};

  let partial: PartialModel | null;
  try {
    partial = buildModel(input.type, metadata);
  } catch {
    partial = null;
  }

  return {
    title: partial?.title ?? FALLBACK_TITLE,
    detail: partial?.detail ?? null,
    timestamp: input.createdAt,
    isUnread: input.readAt === null,
    link: partial ? resolveNotificationLinkPath(input.type, input.entityId, input.metadata) : null,
  };
}
