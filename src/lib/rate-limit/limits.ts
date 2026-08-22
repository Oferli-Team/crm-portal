import type { RateLimitConfig } from "./types";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// Staff login — per IP, credential-stuffing/brute-force protection.
export const LOGIN_LIMIT: RateLimitConfig = { scope: "login", limit: 5, windowMs: 15 * MINUTE_MS };

// Portal login — same reasoning, isolated bucket from staff login.
export const PORTAL_LOGIN_LIMIT: RateLimitConfig = {
  scope: "portal-login",
  limit: 5,
  windowMs: 15 * MINUTE_MS,
};

// Staff signup — per IP, mass account creation protection.
export const SIGNUP_LIMIT: RateLimitConfig = { scope: "signup", limit: 5, windowMs: HOUR_MS };

// Portal signup — same reasoning, isolated bucket from staff signup.
export const PORTAL_SIGNUP_LIMIT: RateLimitConfig = {
  scope: "portal-signup",
  limit: 5,
  windowMs: HOUR_MS,
};

// Sale-Ready Phase B, PR1 (Password Recovery) — per IP, same reasoning and
// same ceiling as LOGIN_LIMIT: this is the one unauthenticated,
// abuse-prone surface in the whole flow (an attacker spamming "forgot
// password" for many emails, or hammering one email's mailbox). The
// confirm/reset steps that follow all require a real, already-issued
// token first, so they don't need their own limiter — matches the
// existing convention of only rate-limiting genuinely unauthenticated
// entry points, not every mutation downstream of one.
export const PASSWORD_RESET_REQUEST_LIMIT: RateLimitConfig = {
  scope: "password-reset-request",
  limit: 5,
  windowMs: 15 * MINUTE_MS,
};

// Portal password reset request — same reasoning, isolated bucket from staff.
export const PORTAL_PASSWORD_RESET_REQUEST_LIMIT: RateLimitConfig = {
  scope: "portal-password-reset-request",
  limit: 5,
  windowMs: 15 * MINUTE_MS,
};

// Invite a team member — per inviting staff user, spam-invite protection.
export const INVITE_MEMBER_LIMIT: RateLimitConfig = {
  scope: "invite-member",
  limit: 10,
  windowMs: HOUR_MS,
};

// Invite a Client Portal user — per inviting staff user.
export const INVITE_PORTAL_USER_LIMIT: RateLimitConfig = {
  scope: "invite-portal-user",
  limit: 10,
  windowMs: HOUR_MS,
};

// Resend a team invitation — per invitation id, not per actor: caps how many
// times any one invitation's email can be re-sent to its recipient.
export const RESEND_MEMBER_INVITE_LIMIT: RateLimitConfig = {
  scope: "resend-member-invite",
  limit: 5,
  windowMs: HOUR_MS,
};

// Resend a Client Portal invitation — same reasoning, isolated bucket.
export const RESEND_PORTAL_INVITE_LIMIT: RateLimitConfig = {
  scope: "resend-portal-invite",
  limit: 5,
  windowMs: HOUR_MS,
};

// Accept a team invitation — per IP (the accepting identity isn't
// established as a member until this succeeds).
export const ACCEPT_MEMBER_INVITE_LIMIT: RateLimitConfig = {
  scope: "accept-member-invite",
  limit: 20,
  windowMs: HOUR_MS,
};

// Accept a Client Portal invitation — same reasoning, isolated bucket.
export const ACCEPT_PORTAL_INVITE_LIMIT: RateLimitConfig = {
  scope: "accept-portal-invite",
  limit: 20,
  windowMs: HOUR_MS,
};

// Attachment upload — per authenticated staff user, shared across
// Client/Project/Invoice attachments (all three call the same
// uploadAttachmentForEntity()).
export const ATTACHMENT_UPLOAD_LIMIT: RateLimitConfig = {
  scope: "attachment-upload",
  limit: 30,
  windowMs: HOUR_MS,
};

// Attachment download (staff) — lightweight abuse protection, not a hard
// day-to-day limit; per authenticated staff user.
export const ATTACHMENT_DOWNLOAD_LIMIT: RateLimitConfig = {
  scope: "attachment-download",
  limit: 120,
  windowMs: HOUR_MS,
};

// Attachment download (portal) — same reasoning, isolated bucket; per
// authenticated portal user.
export const PORTAL_ATTACHMENT_DOWNLOAD_LIMIT: RateLimitConfig = {
  scope: "portal-attachment-download",
  limit: 120,
  windowMs: HOUR_MS,
};

// Invoice System Official Slice 3, sub-PR 3c — staff signed PDF download.
// Isolated bucket from ATTACHMENT_DOWNLOAD_LIMIT: an Invoice PDF is a
// different resource than a user-uploaded Attachment, and the two must
// never throttle each other. Same shape/ceiling as its sibling — this is
// abuse protection, not a hard day-to-day limit; per authenticated staff
// user id.
export const INVOICE_PDF_DOWNLOAD_LIMIT: RateLimitConfig = {
  scope: "invoice-pdf-download",
  limit: 120,
  windowMs: HOUR_MS,
};

// Invoice System Official Slice 3, Portal Invoice PDF access — isolated
// bucket from INVOICE_PDF_DOWNLOAD_LIMIT (staff) and
// PORTAL_ATTACHMENT_DOWNLOAD_LIMIT (a different Portal resource); a
// portal identity's Invoice-PDF downloads must never throttle or be
// throttled by either. Same shape/ceiling as its siblings; per
// authenticated portal user id. Remains the existing in-memory,
// per-instance store — not distributed across server instances.
export const PORTAL_INVOICE_PDF_DOWNLOAD_LIMIT: RateLimitConfig = {
  scope: "portal-invoice-pdf-download",
  limit: 120,
  windowMs: HOUR_MS,
};

// Invoice System Slice 4 — OWNER-only Invoice send/resend. Isolated from
// invitation/notification delivery and keyed by the authenticated staff
// user id before the first Invoice-domain query.
export const INVOICE_EMAIL_SEND_LIMIT: RateLimitConfig = {
  scope: "invoice-email-send",
  limit: 20,
  windowMs: HOUR_MS,
};

// Sale-Ready Phase A.1 (Business Identity), PR4 — per OWNER user id (only
// OWNER can ever call this). A logo is replaced rarely in normal use; this
// ceiling is about abuse (e.g. a compromised OWNER session scripting
// repeated uploads), not legitimate day-to-day usage.
export const LOGO_UPLOAD_LIMIT: RateLimitConfig = { scope: "logo-upload", limit: 20, windowMs: HOUR_MS };

// Cron routes (/api/cron/*) — defense in depth, not the primary barrier
// (CRON_SECRET is). Bucketed per route name (the "identifier" passed to
// checkRateLimit is the route's own fixed name, e.g. "notification-
// delivery"), not per caller — Vercel's own invocations are at most daily
// on this project's plan (see docs/notifications-architecture.md's cron
// section), so a generous per-hour ceiling never blocks a legitimate
// scheduled run, or a few manual re-triggers while debugging, but still
// catches a brute-force secret-guessing script hammering the endpoint.
export const CRON_JOB_LIMIT: RateLimitConfig = { scope: "cron", limit: 20, windowMs: HOUR_MS };

// Comments & Mentions Stage 3 (docs/comments-architecture.md §8) — per
// authenticated staff user, same shape as every other per-user limiter
// above. No number is given in the design doc; these are a deliberate,
// documented MVP ceiling generous enough for normal use, tight enough to
// stop a single account from flooding a Project/Task or mass-notifying
// via repeated mentions.
export const COMMENT_CREATE_LIMIT: RateLimitConfig = { scope: "comment-create", limit: 60, windowMs: HOUR_MS };
export const COMMENT_EDIT_LIMIT: RateLimitConfig = { scope: "comment-edit", limit: 120, windowMs: HOUR_MS };
export const COMMENT_DELETE_LIMIT: RateLimitConfig = { scope: "comment-delete", limit: 60, windowMs: HOUR_MS };

// Global Search Stage 2 (docs/search-architecture.md §6/§8, and this
// stage's own rate-limit decision) — per authenticated staff user, same
// shape as every other per-user limiter above. 200/15min is generous
// enough for legitimate fast typing at Stage 4's planned ~200-250ms
// debounce (worst case a handful of requests per second for a few
// seconds of continuous typing, never sustained for a full 15-minute
// window), while still bounding a scripted enumeration attempt against
// the search endpoint.
export const SEARCH_LIMIT: RateLimitConfig = { scope: "search", limit: 200, windowMs: 15 * MINUTE_MS };

// Billing & Subscriptions Stage 4 — per OWNER user id. Checkout/portal
// session creation now calls a real adapter (mock today, a real provider
// API in Stage 5+) rather than Stage 3's zero-side-effect placeholder, so
// unlike that stage's own "nothing here is worth abuse-limiting" note,
// this is worth bounding — generous enough for a legitimate owner
// comparing plans or opening the portal repeatedly, tight enough to stop
// a compromised/malicious OWNER session from hammering a real provider's
// API once one is connected.
export const BILLING_CHECKOUT_LIMIT: RateLimitConfig = { scope: "billing-checkout", limit: 20, windowMs: HOUR_MS };
export const BILLING_PORTAL_LIMIT: RateLimitConfig = { scope: "billing-portal", limit: 20, windowMs: HOUR_MS };

// Billing & Subscriptions Stage 4 — the webhook route (src/app/api/billing/
// webhook/route.ts). Defense in depth only, the same reasoning as
// CRON_JOB_LIMIT above: signature verification is the real barrier, not
// this. Bucketed by the route's own fixed name, not by caller (a webhook
// sender has no stable per-caller identity this app could key on anyway).
export const BILLING_WEBHOOK_LIMIT: RateLimitConfig = { scope: "billing-webhook", limit: 120, windowMs: HOUR_MS };
