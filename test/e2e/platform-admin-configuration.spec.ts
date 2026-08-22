import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { injectTestSession } from "../support/e2e-session";
import { dbQuery } from "./fixtures";

/**
 * Sale-Ready Phase D — Platform Configuration: D1 (foundation + Legal
 * Configuration surface), D2 (Branding), D3 (Email Configuration), D4
 * (Billing Configuration), D5 (Domain Configuration), and D6
 * (Deployment Information + Environment Information — the final Phase D
 * PR). Its own file, matching the precedent PR2's Dashboard already
 * set: Configuration is a genuinely new top-level feature area (its own
 * nav entry), not an extension of an existing one the way PR3.2/PR3.3
 * extended the Organizations file. Guard/nav coverage stays in
 * platform-admin.spec.ts (already updated for the new nav entry) and
 * isn't repeated here.
 */

const PLATFORM_ADMIN_EMAIL = "platform-admin-e2e@example.com";
const BASE_PATH = "/platform-admin/configuration";

test("renders the Legal Configuration section, including its legalName now resolving through the re-pointed PLATFORM_NAME fallback", async ({
  context,
  baseURL,
}) => {
  await injectTestSession(context, { id: "e2e-platform-admin-configuration", email: PLATFORM_ADMIN_EMAIL }, baseURL!);
  const page = await context.newPage();
  await page.goto(BASE_PATH);

  await expect(page.getByRole("heading", { level: 1, name: "Configuration" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Legal Configuration" })).toBeVisible();

  const legalSection = page.getByRole("region", { name: "Legal Configuration" });
  await expect(legalSection).toBeVisible();

  // TEST_MODE's webServer env (playwright.config.ts) sets none of the
  // PLATFORM_LEGAL_* vars but DOES set PLATFORM_NAME (for the Branding
  // section below) — so this exercises getPlatformLegalConfig()'s own
  // real, re-pointed fallback chain (Sale-Ready Phase D, D2):
  // legalName now falls back through PLATFORM_NAME, not siteConfig.name
  // directly, so "E2E Test Platform" is the correct value here, not
  // "Client Portal CRM".
  await expect(legalSection.getByText("Legal name", { exact: true })).toBeVisible();
  await expect(legalSection.getByText("E2E Test Platform")).toBeVisible();
  await expect(legalSection.getByText("Jurisdiction", { exact: true })).toBeVisible();
  await expect(legalSection.getByText("the jurisdiction in which the Service operator is located")).toBeVisible();
  await expect(legalSection.getByText("Registered address", { exact: true })).toBeVisible();
  await expect(legalSection.getByText("Not set").first()).toBeVisible();
  await expect(legalSection.getByText("Privacy Policy effective date", { exact: true })).toBeVisible();
  await expect(legalSection.getByText("Terms of Service effective date", { exact: true })).toBeVisible();
});

test("renders the Branding section with the configured name/tagline/logo, an honest 'Not set' favicon, and a real logo preview", async ({
  context,
  baseURL,
}) => {
  await injectTestSession(context, { id: "e2e-platform-admin-configuration-branding", email: PLATFORM_ADMIN_EMAIL }, baseURL!);
  const page = await context.newPage();
  await page.goto(BASE_PATH);

  await expect(page.getByRole("heading", { level: 2, name: "Branding" })).toBeVisible();
  const brandingSection = page.getByRole("region", { name: "Branding" });
  await expect(brandingSection).toBeVisible();

  await expect(brandingSection.getByText("Platform name", { exact: true })).toBeVisible();
  await expect(brandingSection.getByText("E2E Test Platform")).toBeVisible();
  await expect(brandingSection.getByText("Platform tagline", { exact: true })).toBeVisible();
  await expect(brandingSection.getByText("Testing tagline for Platform Configuration")).toBeVisible();
  await expect(brandingSection.getByText("Platform logo URL", { exact: true })).toBeVisible();
  await expect(brandingSection.getByText("https://example.com/e2e-test-logo.png")).toBeVisible();

  // Favicon URL is deliberately unset in the webServer env — proves the
  // honest "Not set" path for a branding field, same discipline as the
  // Legal Configuration section's own null fields.
  await expect(brandingSection.getByText("Favicon URL", { exact: true })).toBeVisible();

  // The logo preview: a real <img> whose src is exactly the configured
  // URL — isValidUrl() only suppresses the preview for an unparseable
  // value, and this one is well-formed.
  const logoPreview = brandingSection.getByRole("img", { name: /logo/i });
  await expect(logoPreview).toBeVisible();
  await expect(logoPreview).toHaveAttribute("src", "https://example.com/e2e-test-logo.png");
});

test("renders the Email Configuration section with real addresses, an honest 'Missing'/'Fallback' distinction, and Resend's provider status", async ({
  context,
  baseURL,
}) => {
  await injectTestSession(context, { id: "e2e-platform-admin-configuration-email", email: PLATFORM_ADMIN_EMAIL }, baseURL!);
  const page = await context.newPage();
  await page.goto(BASE_PATH);

  await expect(page.getByRole("heading", { level: 2, name: "Email Configuration" })).toBeVisible();
  const emailSection = page.getByRole("region", { name: "Email Configuration" });
  await expect(emailSection).toBeVisible();

  // Support email resolves through the same INVITATION_FROM_EMAIL
  // fallback getPlatformLegalConfig() already exercises — proves
  // getPlatformEmailConfig() reuses that one fact rather than deriving
  // its own second value.
  await expect(emailSection.getByText("Support email", { exact: true })).toBeVisible();
  await expect(emailSection.getByText("test@example.com").first()).toBeVisible();

  // PLATFORM_BILLING_EMAIL is explicitly set in the webServer env.
  await expect(emailSection.getByText("Billing email", { exact: true })).toBeVisible();
  await expect(emailSection.getByText("billing@example.com")).toBeVisible();

  // Sender email is the address portion of INVITATION_FROM_EMAIL.
  await expect(emailSection.getByText("Sender email", { exact: true })).toBeVisible();

  // Reply-to is deliberately left unset in the webServer env — it must
  // fall back to the sender address (also "test@example.com"), not "Not
  // set", while its own status below honestly reports that as a
  // fallback rather than an operator's explicit choice.
  await expect(emailSection.getByText("Reply-to email", { exact: true })).toBeVisible();

  await expect(emailSection.getByText("Email provider", { exact: true })).toBeVisible();
  await expect(emailSection.getByText("Resend", { exact: true })).toBeVisible();

  // RESEND_API_KEY is set (to a fake value never actually used, since
  // TEST_MODE intercepts every send) — proves the "Configured" path.
  await expect(emailSection.getByText("Provider status", { exact: true })).toBeVisible();
  await expect(emailSection.getByText("Configured", { exact: true }).first()).toBeVisible();

  await expect(emailSection.getByText("Sender status", { exact: true })).toBeVisible();
  await expect(emailSection.getByText("Reply-to status", { exact: true })).toBeVisible();
  await expect(emailSection.getByText("Fallback", { exact: true })).toBeVisible();
});

test("renders the Billing Configuration section reflecting the real TEST_MODE mock adapter — Mode 'Test', every capability Configured", async ({
  context,
  baseURL,
}) => {
  await injectTestSession(context, { id: "e2e-platform-admin-configuration-billing", email: PLATFORM_ADMIN_EMAIL }, baseURL!);
  const page = await context.newPage();
  await page.goto(BASE_PATH);

  await expect(page.getByRole("heading", { level: 2, name: "Billing Configuration" })).toBeVisible();
  const billingSection = page.getByRole("region", { name: "Billing Configuration" });
  await expect(billingSection).toBeVisible();

  // getPlatformBillingConfig() reuses the exact same billing provider
  // registry the checkout/portal Server Actions do — TEST_MODE (set for
  // the whole e2e run) resolves it to the real mock adapter, never a
  // fabricated "everything is fine" value.
  await expect(billingSection.getByText("Billing provider", { exact: true })).toBeVisible();
  await expect(billingSection.getByText("Paddle", { exact: true })).toBeVisible();

  await expect(billingSection.getByText("Provider status", { exact: true })).toBeVisible();
  await expect(billingSection.getByText("Mode", { exact: true })).toBeVisible();
  await expect(billingSection.getByText("Test", { exact: true })).toBeVisible();

  await expect(billingSection.getByText("Checkout", { exact: true })).toBeVisible();
  await expect(billingSection.getByText("Customer portal", { exact: true })).toBeVisible();
  await expect(billingSection.getByText("Webhook", { exact: true })).toBeVisible();
  await expect(billingSection.getByText("Plan synchronization", { exact: true })).toBeVisible();

  // Every capability is available under the mock adapter — at least one
  // "Configured" value is present (exhaustive Configured/Not
  // configured/Disabled branch coverage lives in the unit tests, which
  // also exercise the real production-like unconfigured state this e2e
  // run's fixed TEST_MODE=1 can never reach).
  await expect(billingSection.getByText("Configured", { exact: true }).first()).toBeVisible();
});

test("renders the Domain Configuration section from the real VERCEL_URL, with an honest 'Not configured' custom domain", async ({
  context,
  baseURL,
}) => {
  await injectTestSession(context, { id: "e2e-platform-admin-configuration-domain", email: PLATFORM_ADMIN_EMAIL }, baseURL!);
  const page = await context.newPage();
  await page.goto(BASE_PATH);

  await expect(page.getByRole("heading", { level: 2, name: "Domain Configuration" })).toBeVisible();
  const domainSection = page.getByRole("region", { name: "Domain Configuration" });
  await expect(domainSection).toBeVisible();

  // APP_BASE_URL is deliberately left unset in the webServer env, so
  // getPlatformDomainConfig() resolves everything through VERCEL_URL —
  // proving the real "Default domain" path, not a fabricated custom one.
  await expect(domainSection.getByText("Current domain", { exact: true })).toBeVisible();
  await expect(domainSection.getByText("e2e-test-app.vercel.app").first()).toBeVisible();

  await expect(domainSection.getByText("Default Vercel domain", { exact: true })).toBeVisible();

  await expect(domainSection.getByText("Custom domain", { exact: true })).toBeVisible();
  await expect(domainSection.getByText("Not configured", { exact: true })).toBeVisible();

  await expect(domainSection.getByText("Domain status", { exact: true })).toBeVisible();
  await expect(domainSection.getByText("Default domain", { exact: true })).toBeVisible();

  await expect(domainSection.getByText("HTTPS", { exact: true })).toBeVisible();
  await expect(domainSection.getByText("Enabled", { exact: true })).toBeVisible();

  await expect(domainSection.getByText("Deployment URL", { exact: true })).toBeVisible();
  await expect(domainSection.getByText("https://e2e-test-app.vercel.app", { exact: true })).toBeVisible();
});

test("renders the Deployment Information section with a real GitHub commit link built from VERCEL_GIT_* vars", async ({
  context,
  baseURL,
}) => {
  await injectTestSession(context, { id: "e2e-platform-admin-configuration-deployment", email: PLATFORM_ADMIN_EMAIL }, baseURL!);
  const page = await context.newPage();
  await page.goto(BASE_PATH);

  await expect(page.getByRole("heading", { level: 2, name: "Deployment Information" })).toBeVisible();
  const deploymentSection = page.getByRole("region", { name: "Deployment Information" });
  await expect(deploymentSection).toBeVisible();

  await expect(deploymentSection.getByText("Environment", { exact: true })).toBeVisible();
  await expect(deploymentSection.getByText("production", { exact: true })).toBeVisible();

  await expect(deploymentSection.getByText("Git commit", { exact: true })).toBeVisible();
  const commitLink = deploymentSection.getByRole("link", { name: "abcdef1" });
  await expect(commitLink).toBeVisible();
  await expect(commitLink).toHaveAttribute(
    "href",
    "https://github.com/e2e-test-owner/e2e-test-repo/commit/abcdef1234567890abcdef1234567890abcdef12",
  );
});

test("renders the Environment Information rollup, deriving every row from the same readers the sections above already used", async ({
  context,
  baseURL,
}) => {
  await injectTestSession(context, { id: "e2e-platform-admin-configuration-environment", email: PLATFORM_ADMIN_EMAIL }, baseURL!);
  const page = await context.newPage();
  await page.goto(BASE_PATH);

  await expect(page.getByRole("heading", { level: 2, name: "Environment Information" })).toBeVisible();
  const environmentSection = page.getByRole("region", { name: "Environment Information" });
  await expect(environmentSection).toBeVisible();

  // A representative mix, not exhaustive per-row assertions (unit tests
  // already cover every reader's own Set/Configured/Not-set branches) —
  // this proves the rollup is wired to the real, already-computed
  // section state, both the "present" and "absent" sides of it.
  await expect(environmentSection.getByText("Platform logo", { exact: true })).toBeVisible();
  await expect(environmentSection.getByText("Favicon", { exact: true })).toBeVisible();
  await expect(environmentSection.getByText("Email provider (Resend)", { exact: true })).toBeVisible();
  await expect(environmentSection.getByText("Custom domain", { exact: true })).toBeVisible();
  await expect(environmentSection.getByText("Legal registered address", { exact: true })).toBeVisible();

  // PLATFORM_LOGO_URL, RESEND_API_KEY are set in the webServer env ->
  // "Set"/"Configured"; PLATFORM_FAVICON_URL and PLATFORM_LEGAL_ADDRESS
  // are not -> "Not set". Both states genuinely present in one run.
  await expect(environmentSection.getByText("Set", { exact: true }).first()).toBeVisible();
  await expect(environmentSection.getByText("Not set", { exact: true }).first()).toBeVisible();
  await expect(environmentSection.getByText("Configured", { exact: true }).first()).toBeVisible();
});

test("an ordinary tenant user is redirected away from Configuration", async ({ context, baseURL }) => {
  const userId = randomUUID();
  await injectTestSession(context, { id: userId, email: `e2e-configuration-ordinary-${Date.now()}@example.com` }, baseURL!);
  const page = await context.newPage();
  try {
    // Visiting /dashboard as a fresh identity auto-provisions a real
    // Organization/Membership/Subscription (current-user.ts's own
    // getOrCreateOrganizationId) — a valid UUID id is required for that
    // real Prisma upsert to succeed, unlike the allowlisted-admin test
    // above, whose identity never reaches Prisma at all.
    await page.goto(BASE_PATH);
    await page.waitForURL(/\/dashboard$/);
  } finally {
    await dbQuery("organization", "deleteMany", {
      where: { id: (await dbQuery<{ organizationId: string }>("membership", "findFirstOrThrow", { where: { userId } })).organizationId },
    });
    await dbQuery("user", "delete", { where: { id: userId } });
  }
});

test("an anonymous visitor is redirected to login", async ({ page }) => {
  await page.goto(BASE_PATH);
  await expect(page).toHaveURL(/\/login$/);
});
