import type { CookieOptionsWithName } from "@supabase/ssr";

/**
 * Shared cookie policy for every createServerClient() call site (both
 * server.ts and middleware.ts) — the single source of truth for how the
 * Supabase Auth session cookie is stored, so the two call sites can never
 * silently drift apart.
 *
 * Only httpOnly/secure/sameSite/path are set here. Max-Age/expiry, the
 * cookie name(s), and any chunking @supabase/ssr uses for a large session
 * value are all left to the library's own defaults — those govern the
 * actual session lifecycle, and this app has no reason to second-guess
 * them. Every cookie chunk @supabase/ssr writes goes through this same
 * `cookieOptions`, so a chunked session is hardened uniformly, not just
 * its first piece.
 *
 * httpOnly is hardened to true. This is safe with zero functional impact:
 * this app has no browser-side Supabase client (no createBrowserClient
 * call, no src/lib/supabase/client.ts) and never reads document.cookie
 * anywhere — verified by a repository-wide search before this was written.
 * Nothing in the client bundle needs JS access to this cookie.
 *
 * secure follows the same NODE_ENV check every other app-set cookie
 * already uses (see current-user.ts's activeOrgCookieOptions()), so local
 * http://localhost development keeps working while production — served
 * over HTTPS — gets the Secure flag.
 */
export function getSupabaseCookieOptions(): CookieOptionsWithName {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  };
}
