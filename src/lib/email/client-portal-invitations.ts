import { sendEmailViaResend, type SendEmailFn } from "./resend-client";
import { buildEmailLegalFooterHtml, buildEmailLegalFooterText } from "./legal-footer";

export type SendClientPortalInvitationEmailParams = {
  to: string;
  clientName: string;
  invitedByName: string;
  invitationToken: string;
  expiresAt: Date;
};

export type SendClientPortalInvitationEmailResult =
  | { delivered: true }
  | { delivered: false; reason: "not_configured" | "provider_error" | "network_error" };

/**
 * Same reasoning as src/lib/email/invitations.ts's getAppBaseUrl: never
 * derived from a request's Host header or window.location, both of which
 * are the wrong trust boundary for a link rendered inside an email.
 * Deliberately its own copy rather than a shared import, so a future
 * change to the staff invitation flow can never alter Client Portal
 * invitation links (or vice versa) by accident.
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

function formatExpiry(expiresAt: Date): string {
  return expiresAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function renderHtml(params: {
  clientName: string;
  invitedByName: string;
  inviteUrl: string;
  expiresAt: Date;
}): string {
  const clientName = escapeHtml(params.clientName);
  const invitedByName = escapeHtml(params.invitedByName);
  const inviteUrl = escapeHtml(params.inviteUrl);
  const expires = formatExpiry(params.expiresAt);

  return `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #111827; line-height: 1.5; margin: 0; padding: 24px;">
    <p>${invitedByName} invited you to the <strong>Client Portal</strong> for <strong>${clientName}</strong>.</p>
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
      If you weren't expecting this Client Portal invitation, you can safely ignore this email.
    </p>
    ${buildEmailLegalFooterHtml()}
  </body>
</html>`;
}

function renderText(params: {
  clientName: string;
  invitedByName: string;
  inviteUrl: string;
  expiresAt: Date;
}): string {
  const expires = formatExpiry(params.expiresAt);

  return [
    `${params.invitedByName} invited you to the Client Portal for ${params.clientName}.`,
    "",
    `Accept your invitation: ${params.inviteUrl}`,
    "",
    `This invitation expires on ${expires}.`,
    "",
    "If you weren't expecting this Client Portal invitation, you can safely ignore this email.",
    buildEmailLegalFooterText(),
  ].join("\n");
}

/**
 * Sends a Client Portal invitation email via Resend. Server-only —
 * imported exclusively from Portal Access server actions, never from
 * client code. Reuses the same sendEmailViaResend HTTP adapter as staff
 * invitations; this file only owns the Client Portal-specific subject,
 * body, and link — never a second email provider/transport, and never a
 * Supabase Auth email (Supabase never sends mail for this flow).
 *
 * Never throws: provider/network failures come back as a typed
 * `{ delivered: false, reason }` so the caller can report partial success
 * (the ClientInvitation/Activity rows are already committed) with a Copy
 * link fallback. Never logs the request/response body, the token, or any
 * header.
 */
export async function sendClientPortalInvitationEmail(
  params: SendClientPortalInvitationEmailParams,
  deps: { sendEmail?: SendEmailFn } = {},
): Promise<SendClientPortalInvitationEmailResult> {
  const sendEmail = deps.sendEmail ?? sendEmailViaResend;
  const fromEmail = process.env.INVITATION_FROM_EMAIL;

  if (!fromEmail) {
    return { delivered: false, reason: "not_configured" };
  }

  const inviteUrl = `${getAppBaseUrl()}/portal/invite/${encodeURIComponent(params.invitationToken)}`;

  const result = await sendEmail({
    to: params.to,
    from: fromEmail,
    subject: `You've been invited to the Client Portal for ${params.clientName}`,
    html: renderHtml({ ...params, inviteUrl }),
    text: renderText({ ...params, inviteUrl }),
  });

  if (!result.ok) {
    return { delivered: false, reason: result.reason };
  }

  return { delivered: true };
}
