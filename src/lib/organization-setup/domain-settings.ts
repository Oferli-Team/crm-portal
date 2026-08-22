import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { ParsedDomainSettingsInput } from "@/lib/validation/domain-settings";

export type DomainSettingsData = {
  customDomain: string | null;
  verificationStatus: "PENDING" | "VERIFIED" | null;
};

/**
 * Resolves this app's own base domain the exact same trusted way every
 * other absolute-URL builder in this codebase already does (see e.g.
 * src/lib/email/invitations.ts's own getAppBaseUrl) — APP_BASE_URL is the
 * explicit override, VERCEL_URL is Vercel's own automatic per-deployment
 * value (not user input), localhost is the last-resort dev fallback.
 * Never derived from a request header or window.location.
 */
function getAppRootDomain(): string {
  const explicit = process.env.APP_BASE_URL;
  if (explicit) {
    try {
      return new URL(explicit).host;
    } catch {
      // Malformed override — fall through to the next candidate.
    }
  }

  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) return vercelUrl;

  return "localhost:3000";
}

/**
 * Never stored — always computed from this Organization's own unique,
 * already-real `slug` plus the app's base domain (see this module's own
 * schema-comment counterpart in prisma/schema.prisma). Purely a display
 * value: no subdomain-based routing exists anywhere in this app, and
 * this stage does not add any (out of scope — "do not redesign existing
 * architecture").
 */
export function getGeneratedSubdomain(slug: string): string {
  return `${slug}.${getAppRootDomain()}`;
}

/** Read-only — never role-gated (any member may view), matching authorization.ts's own documented boundary. */
export async function getDomainSettings(organizationId: string): Promise<DomainSettingsData> {
  const row = await prisma.organizationDomainSettings.findUnique({
    where: { organizationId },
    select: { customDomain: true, verificationStatus: true },
  });
  return row ?? { customDomain: null, verificationStatus: null };
}

export type UpsertDomainSettingsResult = { ok: true } | { ok: false; error: string };

/**
 * OWNER-only — callers must call assertCanManageDomainSettings() first.
 * Changing the custom domain always resets verificationStatus back to
 * PENDING — an honest touch even though nothing on this branch ever
 * verifies anything (see DomainVerificationStatus's own schema comment):
 * a changed domain genuinely has never been checked against its new
 * value, so leaving a stale VERIFIED (once a later stage can ever set
 * it) would be actively misleading.
 */
export async function upsertDomainSettings(organizationId: string, input: ParsedDomainSettingsInput): Promise<UpsertDomainSettingsResult> {
  try {
    await prisma.organizationDomainSettings.upsert({
      where: { organizationId },
      update: { customDomain: input.customDomain, verificationStatus: "PENDING" },
      create: { organizationId, customDomain: input.customDomain, verificationStatus: "PENDING" },
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "That domain is already in use by another organization." };
    }
    throw err;
  }
}
