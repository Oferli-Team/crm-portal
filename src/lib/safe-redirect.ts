const FALLBACK_PATH = "/dashboard";

/**
 * Narrows an untrusted redirect target (query param, form field) down to a
 * same-origin relative path, or the app's default landing page otherwise.
 *
 * Rejects anything that isn't a single leading "/" followed by a normal
 * path character — in particular "//evil.com" and "/\evil.com", both of
 * which some browsers normalize into a protocol-relative (cross-origin)
 * URL despite starting with a slash. This is the only thing standing
 * between a login/signup redirectTo param and an open redirect.
 */
export function sanitizeRedirectPath(
  input: string | null | undefined,
  fallback: string = FALLBACK_PATH,
): string {
  if (!input) return fallback;
  if (typeof input !== "string") return fallback;
  if (!/^\/(?!\/|\\)/.test(input)) return fallback;
  if (/[\r\n]/.test(input)) return fallback;
  return input;
}

const PORTAL_FALLBACK_PATH = "/portal";

/**
 * Same open-redirect protections as sanitizeRedirectPath, plus an
 * additional constraint specific to the Client Portal login: the result
 * must stay within /portal. Without this, a crafted redirectTo of
 * "/dashboard" would pass sanitizeRedirectPath's own checks (it's a
 * perfectly normal same-origin path) and send a portal login toward the
 * staff dashboard — a portal identity has no business ever landing there.
 */
export function sanitizePortalRedirectPath(input: string | null | undefined): string {
  const candidate = sanitizeRedirectPath(input, PORTAL_FALLBACK_PATH);
  return candidate === "/portal" || candidate.startsWith("/portal/")
    ? candidate
    : PORTAL_FALLBACK_PATH;
}
