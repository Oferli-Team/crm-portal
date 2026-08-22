import { TEST_MODE } from "@/lib/test-mode";

// Reads process.env.RESEND_API_KEY (a server-only secret) and is only ever
// imported from "use server" action files, so this never reaches the
// client bundle — same trust boundary as src/lib/prisma.ts.
const RESEND_API_URL = "https://api.resend.com/emails";

// Invoice System Slice 4, PR 4a — a conservative, explicit ceiling on the
// caller-supplied timeoutMs, independent of any provider-side limit: this
// module has no retry logic of its own, so a send that hasn't gotten a
// response within 30s gains nothing from waiting longer.
const MAX_SEND_EMAIL_TIMEOUT_MS = 30_000;

// The Idempotency-Key header's value is opaque to this module — Slice 4's
// own future caller additionally enforces UUIDv4 — only structural
// header-safety is enforced here: a bounded length, and no character that
// could inject a second header or split/truncate the request.
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

export type SendEmailAttachment = {
  filename: string;
  content: string; // already Base64
  content_type?: string;
};

export type SendEmailInput = {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  attachments?: SendEmailAttachment[];
  timeoutMs?: number;
  idempotencyKey?: string;
};

export type SendEmailResult =
  | { ok: true; messageId?: string }
  | { ok: false; reason: "not_configured" | "provider_error" | "network_error" };

export type SendEmailFn = (input: SendEmailInput) => Promise<SendEmailResult>;

export type EmailProviderReadiness = "ready" | "not_configured";

/**
 * Reports whether the email provider is ready to send, as a bounded
 * category only — never the configured API key or from-address
 * themselves. Always "ready" under TEST_MODE (this sandbox has no real
 * Resend to reach any more than it has a real Supabase; Slice 4's own E2E
 * suite would otherwise be structurally impossible to exercise). This
 * never weakens `sendEmailViaResend()`'s own independent RESEND_API_KEY
 * check below, which still runs on every real send regardless of what
 * this reports.
 */
export function checkEmailProviderReadiness(): EmailProviderReadiness {
  if (TEST_MODE) {
    return "ready";
  }

  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.INVITATION_FROM_EMAIL;
  if (!apiKey?.trim() || !fromEmail?.trim()) {
    return "not_configured";
  }
  return "ready";
}

function hasHeaderInjectionCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // Any C0 control character (includes CR 0x0D, LF 0x0A, NUL, tab) or DEL.
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isValidIdempotencyKey(key: string): boolean {
  return key.length >= 1 && key.length <= MAX_IDEMPOTENCY_KEY_LENGTH && !hasHeaderInjectionCharacter(key);
}

function isValidTimeoutMs(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= MAX_SEND_EMAIL_TIMEOUT_MS;
}

function extractMessageId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const id = (body as Record<string, unknown>).id;
  if (typeof id !== "string" || id.length === 0 || id.length > 128) return undefined;
  return id;
}

function acceptedResult(messageId: string | undefined): SendEmailResult {
  return messageId !== undefined ? { ok: true, messageId } : { ok: true };
}

/**
 * Thin fetch wrapper around Resend's HTTP API — chosen over the `resend`
 * SDK because it's a single JSON POST with a bearer token; a native fetch
 * call needs no extra dependency and is trivially swappable for a mock in
 * tests (see the `sendEmail` DI param on sendInvitationEmail).
 *
 * Never logs the request body (contains the recipient/invite link), the
 * response body (Resend may echo request fields back), any header, or the
 * idempotency key — only a coarse, non-identifying reason (and, on
 * success, an optional bounded provider message id) is ever returned to
 * the caller.
 *
 * Purely additive over the original four-field shape: `attachments`,
 * `timeoutMs`, and `idempotencyKey` are all optional, so every existing
 * caller (invitations.ts, client-portal-invitations.ts, password-reset.ts,
 * deliver-notification-email.ts) compiles and behaves identically without
 * modification, and the request body it serializes is byte-identical to
 * before when none of the new fields are supplied.
 */
export async function sendEmailViaResend(input: SendEmailInput): Promise<SendEmailResult> {
  // Malformed optional foundation fields fail before the TEST_MODE
  // short-circuit below — otherwise this validation would be structurally
  // untestable, since Slice 4's own E2E suite runs exclusively under
  // TEST_MODE. This branch is unreachable for any existing caller (none
  // supplies these fields) and for any compliant Slice 4 input.
  if (input.idempotencyKey !== undefined && !isValidIdempotencyKey(input.idempotencyKey)) {
    return { ok: false, reason: "provider_error" };
  }
  if (input.timeoutMs !== undefined && !isValidTimeoutMs(input.timeoutMs)) {
    return { ok: false, reason: "provider_error" };
  }

  // E2E-only fake, gated on the identical TEST_MODE flag src/lib/test-
  // mode.ts's identity bypass and src/lib/storage/test-storage.ts's fake
  // Storage both use — never a second independent check. This sandbox has
  // no real Resend to reach any more than it has real Supabase, so a real
  // send is equally unreachable in an E2E run; this reports the same
  // shape a real successful send would, without ever calling fetch() or
  // needing a real RESEND_API_KEY/INVITATION_FROM_EMAIL.
  if (TEST_MODE) {
    return { ok: true };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: "not_configured" };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (input.idempotencyKey !== undefined) {
    headers["Idempotency-Key"] = input.idempotencyKey;
  }

  const body: Record<string, unknown> = {
    from: input.from,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
  };
  if (input.attachments !== undefined) {
    body.attachments = input.attachments.map((attachment) => ({
      filename: attachment.filename,
      content: attachment.content,
      ...(attachment.content_type !== undefined ? { content_type: attachment.content_type } : {}),
    }));
  }

  const controller = input.timeoutMs !== undefined ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), input.timeoutMs) : undefined;

  try {
    let response: Response;
    try {
      response = await fetch(RESEND_API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller?.signal,
      });
    } catch {
      return { ok: false, reason: "network_error" };
    }

    if (!response.ok) {
      return { ok: false, reason: "provider_error" };
    }

    // Provider acceptance is already known at this point (2xx) — a failed
    // or aborted read of the response body must never downgrade this to a
    // failure; it only means messageId stays absent. The same
    // AbortController/timer that bounds the fetch above also bounds this
    // read, since the timer is only cleared in the `finally` below, after
    // this attempt has settled.
    try {
      const parsed: unknown = await response.json();
      return acceptedResult(extractMessageId(parsed));
    } catch {
      return { ok: true };
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
