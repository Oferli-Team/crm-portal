import { sendEmailViaResend, type SendEmailFn } from "./resend-client";
import { buildEmailLegalFooterHtml, buildEmailLegalFooterText } from "./legal-footer";

export type SendInvitationEmailParams = {
  to: string;
  organizationName: string;
  role: "ADMIN" | "MEMBER";
  invitedByName: string;
  invitationToken: string;
  expiresAt: Date;
};

export type SendInvitationEmailResult =
  | { delivered: true }
  | { delivered: false; reason: "not_configured" | "provider_error" | "network_error" };

/**
 * Resolves the base URL invitation links are built from. Deliberately
 * server-only and never derived from a request's Host/X-Forwarded-Host
 * header (both are attacker-controllable) or from window.location (email
 * rendering never runs in a browser). APP_BASE_URL is the explicit,
 * trusted override; VERCEL_URL (set automatically by Vercel for every
 * deployment, preview or production — not user input) is a safe fallback
 * so Preview deployments work with zero extra config; localhost is the
 * last resort for local dev.
 */
function getAppBaseUrl(): string {
  const explicit = process.env.APP_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`.replace(/\/+$/, "");

  return "http://localhost:3000";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatRole(role: "ADMIN" | "MEMBER"): string {
  return role === "ADMIN" ? "Admin" : "Member";
}

function formatExpiry(expiresAt: Date): string {
  return expiresAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function renderHtml(params: {
  organizationName: string;
  invitedByName: string;
  role: "ADMIN" | "MEMBER";
  inviteUrl: string;
  expiresAt: Date;
}): string {
  const organizationName = escapeHtml(params.organizationName);
  const invitedByName = escapeHtml(params.invitedByName);
  const inviteUrl = escapeHtml(params.inviteUrl);
  const roleLabel = formatRole(params.role);
  const expires = formatExpiry(params.expiresAt);

  return `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #111827; line-height: 1.5; margin: 0; padding: 24px;">
    <p>${invitedByName} invited you to join <strong>${organizationName}</strong> as ${roleLabel}.</p>
    <p style="margin: 24px 0;">
      <a href="${inviteUrl}" style="display: inline-block; background: #000000; color: #ffffff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600;">
        Accept invitation
      </a>
    </p>
    <p style="color: #4b5563; font-size: 13px;">
      Or copy this link into your browser:<br />
      <span style="word-break: break-all;">${inviteUrl}</span>
    </p>
    <p style="color: #4b5563; font-size: 13px;">This invitation expires on ${expires}.</p>
    <p style="color: #6b7280; font-size: 12px; margin-top: 32px;">
      If you weren't expecting this invitation, you can safely ignore this email.
    </p>
    ${buildEmailLegalFooterHtml()}
  </body>
</html>`;
}

function renderText(params: {
  organizationName: string;
  invitedByName: string;
  role: "ADMIN" | "MEMBER";
  inviteUrl: string;
  expiresAt: Date;
}): string {
  const roleLabel = formatRole(params.role);
  const expires = formatExpiry(params.expiresAt);

  return [
    `${params.invitedByName} invited you to join ${params.organizationName} as ${roleLabel}.`,
    "",
    `Accept your invitation: ${params.inviteUrl}`,
    "",
    `This invitation expires on ${expires}.`,
    "",
    "If you weren't expecting this invitation, you can safely ignore this email.",
    buildEmailLegalFooterText(),
  ].join("\n");
}

/**
 * Sends an invitation email via Resend. Server-only — imported exclusively
 * from Team server actions, never from client code.
 *
 * Never throws: provider/network failures come back as a typed
 * `{ delivered: false, reason }` so callers (inviteMemberAction,
 * resendInvitationAction) can report a clear partial-success state instead
 * of losing the caller's transaction or crashing the request. The
 * Invitation row itself is always written before this is called — this
 * function has no way to roll that back, by design.
 *
 * `deps.sendEmail` is the sole seam for tests: inject a fake to assert on
 * the recipient/subject/HTML built here, or to simulate provider
 * success/failure, without making a real network call.
 */
export async function sendInvitationEmail(
  params: SendInvitationEmailParams,
  deps: { sendEmail?: SendEmailFn } = {},
): Promise<SendInvitationEmailResult> {
  const sendEmail = deps.sendEmail ?? sendEmailViaResend;
  const fromEmail = process.env.INVITATION_FROM_EMAIL;

  if (!fromEmail) {
    return { delivered: false, reason: "not_configured" };
  }

  const inviteUrl = `${getAppBaseUrl()}/invite/${encodeURIComponent(params.invitationToken)}`;

  const result = await sendEmail({
    to: params.to,
    from: fromEmail,
    subject: `You've been invited to join ${params.organizationName}`,
    html: renderHtml({ ...params, inviteUrl }),
    text: renderText({ ...params, inviteUrl }),
  });

  if (!result.ok) {
    return { delivered: false, reason: result.reason };
  }

  return { delivered: true };
}
