import type { NotificationType } from "@/generated/prisma/enums";
import { buildEmailLegalFooterHtml, buildEmailLegalFooterText } from "@/lib/email/legal-footer";
import { formatInvoiceStatusLabel } from "@/lib/invoices/status-label";

export type NotificationEmailContent = {
  subject: string;
  text: string;
  html: string;
};

export type NotificationEmailFormatInput = {
  type: NotificationType;
  metadata: unknown;
  entityId: string | null;
  /** Looked up by the delivery helper from Notification.organizationId — never from metadata/client input. */
  organizationName: string;
  /** Always APP_BASE_URL (server-resolved) + either the allowlisted link path or "/notifications". */
  ctaUrl: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Every value interpolated into an email body must pass through this — same escaping rule as the invitation emails. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Subject lines are a single header line — a CRLF embedded in an
 * interpolated display name (nothing today stops a User.name or a client
 * name containing one) could otherwise inject extra headers into the raw
 * message. Applied to every value that reaches a subject line, never to
 * text/html bodies (which tolerate newlines fine).
 */
function forSubject(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

const UNKNOWN_ACTOR = "Someone";

type PartialContent = { subject: string; text: string };

function buildRoleChanged(metadata: Record<string, unknown>, organizationName: string): PartialContent {
  const actorName = str(metadata.actorName) ?? UNKNOWN_ACTOR;
  const from = str(metadata.from);
  const to = str(metadata.to);
  const change = from && to ? ` from ${from} to ${to}` : "";
  return {
    subject: `Your role changed in ${organizationName}`,
    text: `${actorName} changed your role${change} in ${organizationName}.`,
  };
}

function buildOwnershipTransferred(metadata: Record<string, unknown>, organizationName: string): PartialContent {
  const actorName = str(metadata.actorName) ?? UNKNOWN_ACTOR;
  const previousOwnerName = str(metadata.previousOwnerName);
  return {
    subject: `You're the new owner of ${organizationName}`,
    text: `${actorName} transferred ownership of ${organizationName} to you${
      previousOwnerName ? ` (previously ${previousOwnerName})` : ""
    }.`,
  };
}

function buildMemberRemoved(metadata: Record<string, unknown>, organizationName: string): PartialContent {
  const actorName = str(metadata.actorName) ?? UNKNOWN_ACTOR;
  return {
    subject: `You were removed from ${organizationName}`,
    text: `${actorName} removed you from ${organizationName}.`,
  };
}

function buildPortalInvitationAccepted(metadata: Record<string, unknown>): PartialContent | null {
  const acceptedUserName = str(metadata.acceptedUserName) ?? UNKNOWN_ACTOR;
  const clientName = str(metadata.clientName);
  if (!clientName) return null;
  const email = str(metadata.email);
  return {
    subject: `${acceptedUserName} accepted Client Portal access`,
    text: `${acceptedUserName}${email ? ` (${email})` : ""} accepted Client Portal access for ${clientName}.`,
  };
}

/**
 * Comments & Mentions Stage 3. parentEntityLabel/parentEntityType are
 * required — without them there's no safe way to say what was commented
 * on, so this degrades to the generic fallback rather than a half sentence
 * (same discipline as buildInvoiceStatusChanged below).
 */
function buildMentioned(metadata: Record<string, unknown>): PartialContent | null {
  const parentEntityLabel = str(metadata.parentEntityLabel);
  const parentEntityTypeRaw = str(metadata.parentEntityType);
  if (!parentEntityLabel || !parentEntityTypeRaw) return null;

  const parentNoun = parentEntityTypeRaw === "TASK" ? "task" : "project";
  const actorName = str(metadata.actorName) ?? UNKNOWN_ACTOR;
  const commentPreview = str(metadata.commentPreview);

  return {
    subject: `${actorName} mentioned you in a comment`,
    text: `${actorName} mentioned you in a comment on ${parentNoun} ${parentEntityLabel}${
      commentPreview ? `: "${commentPreview}"` : "."
    }`,
  };
}

/** invoiceNumber is required — with no invoice to name, there's nothing safe to say. */
function buildInvoiceStatusChanged(metadata: Record<string, unknown>): PartialContent | null {
  const invoiceNumber = str(metadata.invoiceNumber);
  if (!invoiceNumber) return null;

  const actorName = str(metadata.actorName) ?? UNKNOWN_ACTOR;
  const from = str(metadata.from);
  const to = str(metadata.to);
  const projectName = str(metadata.projectName);
  const change = from && to ? ` from ${formatInvoiceStatusLabel(from)} to ${formatInvoiceStatusLabel(to)}` : "";
  const project = projectName ? ` (${projectName})` : "";

  return {
    subject: `Invoice ${invoiceNumber} status changed`,
    text: `${actorName} changed invoice ${invoiceNumber}${project} status${change}.`,
  };
}

/** Billing & Subscriptions Stage 4 (docs/billing-architecture.md §17). Same allowlisted metadata.planName field format-notification.ts's own builders read — never a providerCustomerId/providerSubscriptionId. */
function buildSubscriptionActivated(metadata: Record<string, unknown>, organizationName: string): PartialContent | null {
  const planName = str(metadata.planName);
  if (!planName) return null;
  return {
    subject: `Your ${planName} plan is active`,
    text: `Your ${planName} plan for ${organizationName} is now active.`,
  };
}

function buildPaymentFailed(metadata: Record<string, unknown>, organizationName: string): PartialContent {
  const planName = str(metadata.planName);
  return {
    subject: `Payment failed for ${organizationName}`,
    text: `A payment failed for ${organizationName}${
      planName ? ` (${planName} plan)` : ""
    }. Update your payment method to avoid losing access.`,
  };
}

function buildSubscriptionCanceled(metadata: Record<string, unknown>, organizationName: string): PartialContent {
  const planName = str(metadata.planName);
  return {
    subject: `Your subscription was canceled`,
    text: `The subscription for ${organizationName}${planName ? ` (${planName} plan)` : ""} was canceled.`,
  };
}

function buildPlanChanged(metadata: Record<string, unknown>, organizationName: string): PartialContent | null {
  const planName = str(metadata.planName);
  if (!planName) return null;
  const previousPlanName = str(metadata.previousPlanName);
  return {
    subject: `Your plan changed to ${planName}`,
    text: `${organizationName}'s plan changed${previousPlanName ? ` from ${previousPlanName}` : ""} to ${planName}.`,
  };
}

function buildContent(
  type: NotificationType,
  metadata: Record<string, unknown>,
  organizationName: string,
): PartialContent | null {
  switch (type) {
    case "ROLE_CHANGED":
      return buildRoleChanged(metadata, organizationName);
    case "OWNERSHIP_TRANSFERRED":
      return buildOwnershipTransferred(metadata, organizationName);
    case "MEMBER_REMOVED":
      return buildMemberRemoved(metadata, organizationName);
    case "PORTAL_INVITATION_ACCEPTED":
      return buildPortalInvitationAccepted(metadata);
    case "INVOICE_STATUS_CHANGED":
      return buildInvoiceStatusChanged(metadata);
    case "MENTIONED":
      return buildMentioned(metadata);
    case "SUBSCRIPTION_ACTIVATED":
      return buildSubscriptionActivated(metadata, organizationName);
    case "PAYMENT_FAILED":
      return buildPaymentFailed(metadata, organizationName);
    case "SUBSCRIPTION_CANCELED":
      return buildSubscriptionCanceled(metadata, organizationName);
    case "PLAN_CHANGED":
      return buildPlanChanged(metadata, organizationName);
    // INVITATION_ACCEPTED is a deliberate email non-send (see deliver-
    // notification-email.ts's EMAIL_ALLOWLIST) — never reached in
    // practice, but a safe generic fallback either way, never a throw.
    case "INVITATION_ACCEPTED":
    default:
      return null;
  }
}

const FALLBACK_SUBJECT = "New notification";
const FALLBACK_TEXT = "You have a new notification — view it in the app.";

function renderHtml(params: { bodyText: string; ctaUrl: string }): string {
  const bodyHtml = escapeHtml(params.bodyText);
  const ctaUrl = escapeHtml(params.ctaUrl);

  return `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #111827; line-height: 1.5; margin: 0; padding: 24px;">
    <p>${bodyHtml}</p>
    <p style="margin: 24px 0;">
      <a href="${ctaUrl}" style="display: inline-block; background: #000000; color: #ffffff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600;">
        View in app
      </a>
    </p>
    <p style="color: #4b5563; font-size: 13px;">
      Or copy this link into your browser:<br />
      <span style="word-break: break-all;">${ctaUrl}</span>
    </p>
    ${buildEmailLegalFooterHtml()}
  </body>
</html>`;
}

function renderText(params: { bodyText: string; ctaUrl: string }): string {
  return [params.bodyText, "", `View in app: ${params.ctaUrl}`, buildEmailLegalFooterText()].join("\n");
}

/**
 * Converts a Notification row into email subject/text/html. A separate
 * formatter from format-notification.ts's in-app view model on purpose —
 * email needs full sentences, HTML escaping, and a CRLF-safe subject, none
 * of which the dropdown/list title+detail pair is shaped for. Reuses the
 * same allowlisted metadata fields and the same resolveNotificationLinkPath
 * CTA rule, so the two channels never disagree about what's safe to show.
 *
 * Never throws: malformed/missing fields degrade to a generic subject/body
 * rather than a half-rendered sentence or a crash — deliverNotificationEmails
 * must be able to call this unconditionally for every allowlisted type.
 */
export function formatNotificationEmail(input: NotificationEmailFormatInput): NotificationEmailContent {
  const metadata = isRecord(input.metadata) ? input.metadata : {};

  let partial: PartialContent | null;
  try {
    partial = buildContent(input.type, metadata, input.organizationName);
  } catch {
    partial = null;
  }

  const subject = forSubject(partial?.subject ?? FALLBACK_SUBJECT);
  const bodyText = partial?.text ?? FALLBACK_TEXT;

  return {
    subject,
    text: renderText({ bodyText, ctaUrl: input.ctaUrl }),
    html: renderHtml({ bodyText, ctaUrl: input.ctaUrl }),
  };
}
