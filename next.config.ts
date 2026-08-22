import type { NextConfig } from "next";

// One long-lived Content-Security-Policy, applied to every response via
// headers() below — the single place this app sets security headers, so
// there is never a second, possibly-conflicting copy in middleware.ts.
//
// Every directive here is justified by what this app actually does, not
// copied blindly:
//   - script-src/style-src 'unsafe-inline': Next.js injects its own inline
//     <script> for RSC/hydration payloads on every page, and two dashboard
//     components (revenue-chart.tsx, breakdown-card.tsx) use inline
//     style={{...}} for data-driven bar/percentage widths. Neither can be
//     removed without a nonce-based setup, which would require middleware
//     changes this stage deliberately avoids.
//   - script-src 'unsafe-eval': kept for Next.js App Router's own runtime
//     needs; not verified removable without risking hydration breakage.
//   - font-src allows https: broadly, but nothing external is actually
//     loaded today: next/font/google (Geist/Geist Mono) downloads at build
//     time and self-hosts from /_next/static/media — confirmed via the
//     production Link preload header — so no fonts.gstatic.com request
//     ever happens. img-src's blob:/https: (still no next/image usage
//     anywhere) are both load-bearing as of Sale-Ready Phase A.1 PR5's
//     logo upload widget: blob: for the client-side pre-upload preview,
//     https: for the persisted logo's real Supabase Storage public URL.
//   - connect-src includes https://*.supabase.co and wss://*.supabase.co:
//     this is the app's real Supabase project domain (confirmed from the
//     session cookie name), not an invented origin. The only place the
//     browser ever talks to it directly is the 307 redirect the attachment
//     download routes issue to a signed Storage URL — a plain <a href>
//     top-level navigation, which CSP's fetch directives don't govern
//     anyway — kept here regardless since it's the correct real origin and
//     costs nothing to allow. wss:// is unused today (no Realtime
//     subscriptions exist in this app) but is the real domain, kept for
//     forward compatibility rather than removed and re-added later.
//   - frame-src 'none' / object-src 'none': zero iframes, <object>, or
//     <embed> tags anywhere in the app (grep confirmed).
//   - worker-src 'self' blob:: no Worker/SharedWorker/ServiceWorker usage
//     exists today; kept as a safe default matching the audited template.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' https: data:",
  "style-src 'self' 'unsafe-inline' https:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "accelerometer=()",
  "gyroscope=()",
  "magnetometer=()",
].join(", ");

const nextConfig: NextConfig = {
  // Removes the "X-Powered-By: Next.js" response header — pure information
  // disclosure with no functional purpose.
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Applies to every route this app serves, including API routes —
        // there is no route in this app that needs a different policy.
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
        ],
      },
    ];
  },
  experimental: {
    serverActions: {
      // Next.js's own default (1 MB) is smaller than
      // MAX_ATTACHMENT_SIZE_BYTES (10 MB, see src/lib/storage/attachments-config.ts)
      // — without raising this, a legitimate 2-10MB upload would be
      // rejected by the framework with a raw 413 before ever reaching
      // validateAttachmentFile(). Set above 10MB to leave headroom for
      // multipart/form-data overhead around the raw file bytes.
      bodySizeLimit: "12mb",
    },
    // This app's middleware (src/middleware.ts) makes every request go
    // through the proxy body-buffering path, whose own default cap is also
    // 10MB — identical to our attachment size limit, so a file at or near
    // 10MB was silently truncated mid-multipart-body before reaching the
    // Server Action at all (surfacing as a raw "Unexpected end of form"
    // parse error instead of validateAttachmentFile()'s clean rejection).
    // Raised in lockstep with bodySizeLimit above so our own validation is
    // always what decides accept/reject, never this buffering cap.
    proxyClientMaxBodySize: "12mb",
  },
};

export default nextConfig;
