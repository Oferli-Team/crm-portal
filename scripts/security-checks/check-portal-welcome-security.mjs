import { readFileSync, existsSync } from "node:fs";
import { grep, report } from "./lib.mjs";

// Client Portal welcome banner — Stage 4 (docs/onboarding-architecture.md
// §17). Deliberately the thinnest possible feature: no table, no Server
// Action, no write path at all. Every check here is a structural guard
// that it stays that way, and that it never gets confused with the
// separate, per-Organization staff onboarding system (src/lib/onboarding/*,
// src/components/onboarding/*).

let ok = true;

const PORTAL_COMPONENTS_DIR = "src/components/portal";
const ELIGIBILITY_FILE = "src/components/portal/portal-welcome-eligibility.ts";
const BANNER_FILE = "src/components/portal/portal-welcome-banner.tsx";
const STAFF_APP_DIR = "src/app/(dashboard)";
const ONBOARDING_COMPONENTS_DIR = "src/components/onboarding";

// 1. Nothing under src/components/portal/ ever references the staff
// onboarding table or imports src/lib/onboarding — the two features must
// stay structurally independent, per this stage's own explicit "не
// смешивать" instruction.
const onboardingTableRef = grep("organizationOnboardingStep", PORTAL_COMPONENTS_DIR, "-i");
const onboardingLibImport = grep('from "@/lib/onboarding', PORTAL_COMPONENTS_DIR);
ok = report(
  "the Portal welcome banner never references OrganizationOnboardingStep or imports src/lib/onboarding",
  onboardingTableRef === "" && onboardingLibImport === "",
  [onboardingTableRef, onboardingLibImport].filter(Boolean).join("\n"),
) && ok;

// 2. Nothing under src/components/portal/ creates an Activity or delivers a
// Notification/email — this stage's own explicit "без Activity, без
// Notification" requirement.
const activityImport = grep('from "@/lib/activity/create-activity"', PORTAL_COMPONENTS_DIR);
const notificationEmailImport = grep(
  'from "@/lib/notifications/email/deliver-notification-email"',
  PORTAL_COMPONENTS_DIR,
);
const notificationTableWrite = grep("prisma\\.notification\\.(create|createMany|upsert)", PORTAL_COMPONENTS_DIR);
ok = report(
  "the Portal welcome banner never creates an Activity or delivers/writes a Notification",
  activityImport === "" && notificationEmailImport === "" && notificationTableWrite === "",
  [activityImport, notificationEmailImport, notificationTableWrite].filter(Boolean).join("\n"),
) && ok;

// 3. portal-welcome-eligibility.ts stays a pure function — no Prisma
// import, no "use server"/"use client" directive, no I/O of any kind. This
// is the entire decision surface behind the banner; keeping it pure is
// what makes it unit-testable without a database at all.
const eligibilitySource = existsSync(ELIGIBILITY_FILE) ? readFileSync(ELIGIBILITY_FILE, "utf8") : "";
const eligibilityIsPure =
  !/from ["']@\/lib\/prisma["']/.test(eligibilitySource) &&
  !/"use server"|"use client"/.test(eligibilitySource);
ok = report(
  "portal-welcome-eligibility.ts is a pure function — no Prisma import, no client/server directive",
  existsSync(ELIGIBILITY_FILE) && eligibilityIsPure,
  eligibilitySource ? "" : "eligibility file not found",
) && ok;

// 4. The welcome banner is never rendered from the staff app — it's Portal
// home only (this stage's own explicit placement rule).
const bannerImportInStaffApp = grep("PortalWelcomeBanner", STAFF_APP_DIR);
ok = report(
  "PortalWelcomeBanner is never imported anywhere under the staff app",
  bannerImportInStaffApp === "",
  bannerImportInStaffApp,
) && ok;

// 5. The staff Dashboard OnboardingCard is never imported from the Portal
// side, and vice versa — proven from both directions so neither feature can
// quietly start reusing the other's component.
const onboardingCardImportInPortal = grep("OnboardingCard", PORTAL_COMPONENTS_DIR);
const portalBannerImportInOnboarding = grep("PortalWelcomeBanner", ONBOARDING_COMPONENTS_DIR);
ok = report(
  "the staff OnboardingCard and the Portal welcome banner never import each other",
  onboardingCardImportInPortal === "" && portalBannerImportInOnboarding === "",
  [onboardingCardImportInPortal, portalBannerImportInOnboarding].filter(Boolean).join("\n"),
) && ok;

// 6. PortalWelcomeBanner's own prop list never accepts an organizationId/
// userId/portalUserId — eligibility is always resolved server-side by its
// caller (the Portal page, via getCurrentPortalUser()) and passed down as
// an already-computed boolean, never as an identity the client could forge.
const bannerSource = existsSync(BANNER_FILE) ? readFileSync(BANNER_FILE, "utf8") : "";
const propsBlockMatch = bannerSource.match(/export function PortalWelcomeBanner\(\{([\s\S]*?)\}:/);
const propsBlock = propsBlockMatch ? propsBlockMatch[1] : "";
const FORBIDDEN_PROP_NAMES = /\b(organizationId|userId|portalUserId|clientId)\b/;
ok = report(
  "PortalWelcomeBanner never accepts organizationId/userId/portalUserId/clientId as a prop",
  existsSync(BANNER_FILE) && propsBlock.length > 0 && !FORBIDDEN_PROP_NAMES.test(propsBlock),
  bannerSource ? "" : "banner file not found",
) && ok;

process.exit(ok ? 0 : 1);
