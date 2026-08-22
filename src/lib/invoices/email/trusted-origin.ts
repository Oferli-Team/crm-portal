import { TEST_MODE } from "@/lib/test-mode";

/**
 * Invoice System Slice 4, PR 4a — unwired foundation. Nothing in
 * production imports this yet; it exists so PR 4b's own view-model caller
 * has a trusted, optional origin to build a Portal Invoice link from.
 *
 * Resolves the one trusted origin an Invoice email's Portal link may be
 * built against — or `null` if none can be trusted, in which case the
 * caller must omit the link entirely rather than fall back to anything
 * request-derived. There is deliberately no Host/X-Forwarded-Host
 * parameter here at all (both are attacker-controllable, and email
 * rendering never runs inside a request in the first place — this module
 * takes no request/headers input of any kind).
 *
 * Precedence, each candidate only used if it parses as a valid, absolute,
 * credential-free HTTP/HTTPS origin (see `parseOrigin` below):
 *  1. `APP_BASE_URL` — the explicit, operator-set override (same variable
 *     src/lib/email/invitations.ts's own getAppBaseUrl() already trusts
 *     first, for the identical reason).
 *  2. `VERCEL_PROJECT_PRODUCTION_URL` — per Vercel's own official System
 *     Environment Variables documentation (docs/environment-variables/
 *     system-environment-variables, verified directly, not guessed): "A
 *     production domain name of the project. We select the shortest
 *     production custom domain, or vercel.app domain if no custom domain
 *     is available. Note, that this is always set, even in preview
 *     deployments. This is useful to reliably generate links that point
 *     to production." Deliberately NOT `VERCEL_URL`, which the same
 *     documentation instead describes as "the domain name of the
 *     generated deployment URL" — a unique, per-deployment value that
 *     changes on every deploy (the value getAppBaseUrl() above uses,
 *     appropriate there for a same-deployment invite link, wrong here: an
 *     emailed Invoice PDF may be opened long after the deployment that
 *     sent it has been superseded, so this needs the one stable domain
 *     that survives across deployments, not the one that sent the email).
 *     Vercel never includes a scheme in this value; `https://` is
 *     prepended before parsing.
 *  3. `localhost`, but ONLY in local development or TEST_MODE — never in
 *     a real production deployment with neither of the above configured.
 *     NODE_ENV alone cannot distinguish the Playwright E2E run from a
 *     real production deployment: `next start` (which the E2E webServer
 *     itself runs) sets NODE_ENV=production regardless (see
 *     src/lib/auth/recovery-token.ts's own identical, already-documented
 *     finding) — TEST_MODE is checked explicitly for exactly that reason.
 *
 * Returns `null` in a real production deployment with no trusted origin
 * configured at all — the caller must treat that as "omit the Portal
 * link", never as a reason to block sending the email itself.
 */

const LOCALHOST_ORIGIN = "http://localhost:3000";

function parseOrigin(candidate: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  // Absolute HTTP/HTTPS only — rejects bare hostnames (new URL() already
  // throws on those), and any other scheme (ftp:, mailto:, javascript:, …).
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  // Credentials in the origin (`https://user:pass@host`) are never
  // trusted, silently or otherwise.
  if (parsed.username !== "" || parsed.password !== "") return null;

  // `.origin` — not a manual trailing-slash strip — is what discards any
  // path/query/fragment component and normalizes the result.
  return parsed.origin;
}

export function resolveTrustedInvoiceEmailOrigin(): string | null {
  const explicit = process.env.APP_BASE_URL;
  if (explicit) {
    const parsed = parseOrigin(explicit);
    if (parsed) return parsed;
  }

  const vercelProductionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercelProductionHost) {
    const parsed = parseOrigin(`https://${vercelProductionHost}`);
    if (parsed) return parsed;
  }

  if (process.env.NODE_ENV === "development" || TEST_MODE) {
    return LOCALHOST_ORIGIN;
  }

  return null;
}
