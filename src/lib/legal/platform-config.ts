import { siteConfig } from "@/config/site";

export type PlatformBranding = {
  /** The product's own display name. Always a real value — falls back to siteConfig.name, never "Not set" (a platform necessarily has a name, unlike an optional address). */
  name: string;
  /** Falls back to siteConfig.description, same reasoning as `name`. */
  tagline: string;
  /** Optional. No platform-level logo exists anywhere in this app until an operator sets this — never a placeholder image. */
  logoUrl: string | null;
  /** Optional. Not read by anything in Next.js's own favicon resolution yet (Sale-Ready Phase D, D2 — display-only for now); reserved for a future PR to actually wire in. */
  faviconUrl: string | null;
};

export type PlatformEmailConfig = {
  /** Reused from getPlatformLegalConfig().supportEmail — same fact (one support mailbox), not a second independent source. */
  supportEmail: string | null;
  /** Distinct from supportEmail on purpose: a real operator may want billing inquiries routed to a different mailbox than general/legal support. No fallback exists for this one — inventing a billing contact from an unrelated address would be worse than an honest "Not set". */
  billingEmail: string | null;
  /** The address transactional emails (invitations, password resets) are actually sent from — reuses the same INVITATION_FROM_EMAIL address parsing sendEmailViaResend's own caller already relies on, not a second "from" concept. */
  senderEmail: string | null;
  /** Where a recipient's reply would go. Falls back to senderEmail when not explicitly set (the sender address is always a reasonable place for a reply to land) — see replyToConfigured for whether this is an explicit choice or that fallback. Not yet wired into any actual email send (display-only for now, same "documented ahead of the code that reads it" approach as PLATFORM_FAVICON_URL). */
  replyToEmail: string | null;
  /** The only email-sending integration this app has (see src/lib/email/resend-client.ts) — fixed, not env-driven, because there is nothing to choose between yet. */
  providerName: string;
  /** Whether RESEND_API_KEY is set — never the key's value itself, which is a secret and never rendered anywhere. */
  providerConfigured: boolean;
  /** Whether senderEmail resolved to a real address. */
  senderConfigured: boolean;
  /** True only when PLATFORM_REPLY_TO_EMAIL was explicitly set — false means replyToEmail above is senderEmail's fallback value, not an operator choice. */
  replyToConfigured: boolean;
};

export type PlatformLegalConfig = {
  /** Legal/trading name of the entity operating this Service. */
  legalName: string;
  /** Registered/mailing address, if the operator has configured one — never invented. */
  legalAddress: string | null;
  /** Contact address for privacy/legal requests, if configured. */
  supportEmail: string | null;
  /** Free-text jurisdiction description used in the governing-law clause. */
  jurisdiction: string;
  /** Human-readable effective date shown on the Privacy Policy page. */
  privacyEffectiveDate: string;
  /** Human-readable effective date shown on the Terms of Service page. */
  tosEffectiveDate: string;
};

/**
 * `INVITATION_FROM_EMAIL` is formatted as either `"Name <email@domain>"` or
 * a bare address (see .env.example) — this pulls just the address back out,
 * so it can double as a fallback contact channel without a second real
 * mailbox needing to exist. Returns null for anything that doesn't look
 * like an email, rather than guessing.
 */
function extractEmailAddress(fromHeader: string | undefined): string | null {
  if (!fromHeader) return null;
  const angleMatch = fromHeader.match(/<([^>]+)>/);
  const candidate = (angleMatch ? angleMatch[1] : fromHeader).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : null;
}

function trimmedEnv(name: string): string | null {
  const value = process.env[name];
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Sale-Ready Phase D, D2 (Platform Configuration — Branding). The
 * platform's own visual identity, deliberately in this same module
 * rather than a second configuration system — "what is this platform
 * called" is one fact with one source, not something Branding and Legal
 * each get to answer independently. PLATFORM_NAME is that source: falls
 * back to the existing hardcoded siteConfig.name (zero-config deployments
 * are unchanged), and getPlatformLegalConfig()'s own legalName below now
 * falls back through this function instead of reading siteConfig.name
 * directly — one extra hop in the chain, not a second fact.
 */
export function getPlatformBranding(): PlatformBranding {
  return {
    name: trimmedEnv("PLATFORM_NAME") ?? siteConfig.name,
    tagline: trimmedEnv("PLATFORM_TAGLINE") ?? siteConfig.description,
    logoUrl: trimmedEnv("PLATFORM_LOGO_URL"),
    faviconUrl: trimmedEnv("PLATFORM_FAVICON_URL"),
  };
}

/**
 * Platform-level legal identity, deliberately separate from
 * OrganizationProfile (per-tenant business identity — see Business
 * Identity, Sale-Ready Phase A.1). This describes the ONE operator running
 * this Service for every tenant, not any single customer's own business —
 * it must never read Organization/OrganizationProfile data.
 *
 * Every field degrades to a safe, honest fallback rather than inventing
 * unverified information (a fabricated address or support mailbox would be
 * worse than omitting it) — callers (the /privacy and /terms pages, the
 * Footer, and the transactional email footer) render conditionally around
 * the null cases instead of assuming a value.
 */
export function getPlatformLegalConfig(): PlatformLegalConfig {
  return {
    legalName: trimmedEnv("PLATFORM_LEGAL_NAME") ?? getPlatformBranding().name,
    legalAddress: trimmedEnv("PLATFORM_LEGAL_ADDRESS"),
    supportEmail: trimmedEnv("PLATFORM_SUPPORT_EMAIL") ?? extractEmailAddress(process.env.INVITATION_FROM_EMAIL),
    jurisdiction: trimmedEnv("PLATFORM_JURISDICTION") ?? "the jurisdiction in which the Service operator is located",
    privacyEffectiveDate: trimmedEnv("PRIVACY_POLICY_EFFECTIVE_DATE") ?? "August 9, 2026",
    tosEffectiveDate: trimmedEnv("TOS_EFFECTIVE_DATE") ?? "August 9, 2026",
  };
}

/**
 * Sale-Ready Phase D, D3 (Platform Configuration — Email Configuration).
 * Read-only status of the platform's outbound email setup — never sends
 * anything, never calls Resend, never validates SMTP; purely reflects
 * what's already configured via existing env vars (RESEND_API_KEY,
 * INVITATION_FROM_EMAIL — both already read by src/lib/email/resend-
 * client.ts and callers) plus two new, display-only ones. supportEmail
 * reuses getPlatformLegalConfig()'s own value rather than re-deriving it
 * — one support mailbox, one source, same discipline PR2 established for
 * PLATFORM_NAME.
 */
export function getPlatformEmailConfig(): PlatformEmailConfig {
  const senderEmail = extractEmailAddress(process.env.INVITATION_FROM_EMAIL);
  const explicitReplyTo = trimmedEnv("PLATFORM_REPLY_TO_EMAIL");

  return {
    supportEmail: getPlatformLegalConfig().supportEmail,
    billingEmail: trimmedEnv("PLATFORM_BILLING_EMAIL"),
    senderEmail,
    replyToEmail: explicitReplyTo ?? senderEmail,
    providerName: "Resend",
    providerConfigured: trimmedEnv("RESEND_API_KEY") !== null,
    senderConfigured: senderEmail !== null,
    replyToConfigured: explicitReplyTo !== null,
  };
}

export type PlatformDomainStatus = "Custom domain configured" | "Default domain" | "Not configured";

/**
 * Sale-Ready Phase D, D5 (Platform Configuration — Domain Configuration).
 * A read-only projection of the exact same APP_BASE_URL/VERCEL_URL
 * resolution chain every absolute-URL builder in this codebase already
 * has its own copy of (src/lib/email/invitations.ts's getAppBaseUrl,
 * src/lib/organization-setup/domain-settings.ts's getAppRootDomain, and
 * four more) — this is not a seventh copy of that *logic* for building
 * real links, only a display projection of the same two env vars for
 * this page. Deliberately never calls the Vercel API, never resolves
 * DNS, never makes any network request — every field is pure string
 * inspection of env vars this process already has.
 */
export type PlatformDomainConfig = {
  /** The host this app currently presents itself as — the custom domain's host when configured, otherwise Vercel's own default deployment host, otherwise localhost in local dev. Always a real value, never "Not configured" (see deploymentUrl for the same fact as a full URL). */
  currentDomain: string;
  /** Vercel's own automatic per-deployment host (VERCEL_URL) — present on every real Vercel deployment (preview or production) regardless of whether a custom domain is also configured; null only outside Vercel (local dev). */
  defaultVercelDomain: string | null;
  /** The host portion of APP_BASE_URL, only when it's both set and a well-formed absolute URL — a malformed override is treated the same as unset here (an honest "Not configured" beats displaying an unparseable string as if it were a real domain). */
  customDomain: string | null;
  /** Custom domain configured > Default domain > Not configured, in that priority — mirrors getPlatformBillingConfig()'s Mode field shape (a derived 3-state summary, not a fourth independent fact). */
  domainStatus: PlatformDomainStatus;
  /** Whether the resolved deploymentUrl itself uses https:// — string inspection only, never an actual TLS/certificate check (this app has no way to perform one without a real network call, which this section is expressly forbidden from making). */
  httpsEnabled: boolean;
  /** The full resolved base URL (protocol + host) this app's own email/invitation links are built from today — the same value getAppBaseUrl() returns, just exposed here for display. */
  deploymentUrl: string;
};

function parseHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function getPlatformDomainConfig(): PlatformDomainConfig {
  const explicitBaseUrl = trimmedEnv("APP_BASE_URL")?.replace(/\/+$/, "");
  const vercelUrl = trimmedEnv("VERCEL_URL");
  const explicitBaseUrlHost = explicitBaseUrl ? parseHost(explicitBaseUrl) : null;
  // Only trust the explicit override as a real custom domain once it's
  // proven parseable — a malformed APP_BASE_URL falls through to the
  // Vercel/localhost fallback below rather than becoming deploymentUrl
  // as-is (see this type's own customDomain doc comment).
  const customDomain = explicitBaseUrlHost;

  const deploymentUrl =
    explicitBaseUrl && customDomain
      ? explicitBaseUrl
      : vercelUrl
        ? `https://${vercelUrl}`
        : "http://localhost:3000";

  const domainStatus: PlatformDomainStatus = customDomain
    ? "Custom domain configured"
    : vercelUrl
      ? "Default domain"
      : "Not configured";

  return {
    currentDomain: parseHost(deploymentUrl) ?? deploymentUrl,
    defaultVercelDomain: vercelUrl,
    customDomain,
    domainStatus,
    httpsEnabled: deploymentUrl.startsWith("https://"),
    deploymentUrl,
  };
}

/**
 * Sale-Ready Phase D, D6 (Platform Configuration — Deployment
 * Information). Vercel's own system env vars — auto-injected on every
 * real deployment, never set outside Vercel (local dev sees every field
 * as null, honestly). Pure string reads: no Vercel API call, no GitHub
 * API call, no network request of any kind.
 */
export type PlatformDeploymentConfig = {
  /** VERCEL_ENV raw value ("production" | "preview" | "development"). */
  environment: string | null;
  /** The full commit SHA this deployment was built from. */
  commitSha: string | null;
  /** First 7 characters of commitSha — the same short-SHA length GitHub's own UI uses. */
  commitShaShort: string | null;
  /** A real GitHub commit URL, built only when VERCEL_GIT_PROVIDER is confirmed "github" and the owner/repo/sha are all present — never guessed for an unconfirmed or absent provider. */
  commitUrl: string | null;
};

export function getPlatformDeploymentConfig(): PlatformDeploymentConfig {
  const environment = trimmedEnv("VERCEL_ENV");
  const commitSha = trimmedEnv("VERCEL_GIT_COMMIT_SHA");
  const provider = trimmedEnv("VERCEL_GIT_PROVIDER");
  const repoOwner = trimmedEnv("VERCEL_GIT_REPO_OWNER");
  const repoSlug = trimmedEnv("VERCEL_GIT_REPO_SLUG");

  const commitUrl =
    provider === "github" && repoOwner && repoSlug && commitSha
      ? `https://github.com/${repoOwner}/${repoSlug}/commit/${commitSha}`
      : null;

  return {
    environment,
    commitSha,
    commitShaShort: commitSha ? commitSha.slice(0, 7) : null,
    commitUrl,
  };
}
