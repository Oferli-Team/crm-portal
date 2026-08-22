import { sendEmailViaResend, type SendEmailFn } from "./resend-client";
import { buildEmailLegalFooterHtml, buildEmailLegalFooterText } from "./legal-footer";

export type PasswordResetAudience = "staff" | "portal";

export type SendPasswordResetEmailParams = {
  to: string;
  tokenHash: string;
  audience: PasswordResetAudience;
};

export type SendPasswordResetEmailResult =
  | { delivered: true }
  | { delivered: false; reason: "not_configured" | "provider_error" | "network_error" };

/**
 * Same reasoning as src/lib/email/invitations.ts's getAppBaseUrl (this
 * codebase's own established convention: each email module keeps its own
 * copy rather than sharing one via import — see also client-portal-
 * invitations.ts and deliver-notification-email.ts). Never derived from a
 * request header or window.location — both wrong or unavailable here.
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

/**
 * Points at this app's own /auth/confirm Route Handler, never at
 * Supabase's own action_link — see recovery-token.ts's own doc comment
 * for why. `audience` is only ever a pre-verification default the confirm
 * route re-derives authoritatively from the verified identity afterward
 * (see that route's own doc comment) — it is not itself a security
 * boundary, so passing it through a plain query param is fine.
 */
function buildConfirmUrl(tokenHash: string, audience: PasswordResetAudience): string {
  const params = new URLSearchParams({ token_hash: tokenHash, audience });
  return `${getAppBaseUrl()}/auth/confirm?${params.toString()}`;
}

export type PasswordResetEmailContent = { subject: string; html: string; text: string };

function renderHtml(params: { confirmUrl: string; audience: PasswordResetAudience }): string {
  const confirmUrl = escapeHtml(params.confirmUrl);
  const product = params.audience === "portal" ? "Client Portal" : "your account";

  return `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #111827; line-height: 1.5; margin: 0; padding: 24px;">
    <p>We received a request to reset the password for ${product}.</p>
    <p style="margin: 24px 0;">
      <a href="${confirmUrl}" style="display: inline-block; background: #000000; color: #ffffff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600;">
        Reset password
      </a>
    </p>
    <p style="color: #4b5563; font-size: 13px;">
      Or copy this link into your browser:<br />
      <span style="word-break: break-all;">${confirmUrl}</span>
    </p>
    <p style="color: #4b5563; font-size: 13px;">This link expires in 1 hour and can only be used once.</p>
    <p style="color: #6b7280; font-size: 12px; margin-top: 32px;">
      If you didn't request a password reset, you can safely ignore this email — your password will not be changed.
    </p>
    ${buildEmailLegalFooterHtml()}
  </body>
</html>`;
}

function renderText(params: { confirmUrl: string; audience: PasswordResetAudience }): string {
  const product = params.audience === "portal" ? "Client Portal" : "your account";

  return [
    `We received a request to reset the password for ${product}.`,
    "",
    `Reset your password: ${params.confirmUrl}`,
    "",
    "This link expires in 1 hour and can only be used once.",
    "",
    "If you didn't request a password reset, you can safely ignore this email — your password will not be changed.",
    buildEmailLegalFooterText(),
  ].join("\n");
}

/**
 * The pure part of this module — no network, no env vars beyond what's
 * already been resolved into `confirmUrl` by the caller. Exported
 * specifically so it's unit-testable directly, the same shape as
 * src/lib/notifications/email/format-notification-email.ts's own
 * formatNotificationEmail: this is what varies per input, sendEmailViaResend
 * (Resend, the network boundary) never does.
 */
export function buildPasswordResetEmailContent(params: {
  confirmUrl: string;
  audience: PasswordResetAudience;
}): PasswordResetEmailContent {
  return {
    subject: params.audience === "portal" ? "Reset your Client Portal password" : "Reset your password",
    html: renderHtml(params),
    text: renderText(params),
  };
}

/**
 * Sends a password reset email via Resend. Server-only — imported
 * exclusively from src/lib/auth/password-reset.ts, never from client code.
 *
 * Never throws: provider/network failures come back as a typed
 * `{ delivered: false, reason }`, matching sendInvitationEmail's own
 * contract exactly. `deps.sendEmail` is the sole seam for tests — inject a
 * fake to assert on the recipient/link built here without a real network
 * call, same pattern as sendInvitationEmail's own deps.sendEmail.
 */
export async function sendPasswordResetEmail(
  params: SendPasswordResetEmailParams,
  deps: { sendEmail?: SendEmailFn } = {},
): Promise<SendPasswordResetEmailResult> {
  const sendEmail = deps.sendEmail ?? sendEmailViaResend;
  const fromEmail = process.env.INVITATION_FROM_EMAIL;

  if (!fromEmail) {
    return { delivered: false, reason: "not_configured" };
  }

  const confirmUrl = buildConfirmUrl(params.tokenHash, params.audience);
  const content = buildPasswordResetEmailContent({ confirmUrl, audience: params.audience });

  const result = await sendEmail({
    to: params.to,
    from: fromEmail,
    subject: content.subject,
    html: content.html,
    text: content.text,
  });

  if (!result.ok) {
    return { delivered: false, reason: result.reason };
  }

  return { delivered: true };
}
