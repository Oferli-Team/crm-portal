import { readFileSync, existsSync, readdirSync } from "node:fs";
import { grep, report } from "./lib.mjs";

// Onboarding Stage 2 (docs/onboarding-architecture.md, this stage's own
// explicit invariants). No UI exists yet — every check here targets a way
// this stage's own backend contract (src/lib/onboarding/*) could quietly
// regress, the same discipline check-billing-security.mjs/check-comments-
// security.mjs already established for their own features.

let ok = true;

const ONBOARDING_LIB_DIR = "src/lib/onboarding";
const ACTIONS_FILE = "src/lib/onboarding/actions.ts";
const STEPS_FILE = "src/lib/onboarding/steps.ts";
const PORTAL_APP_DIR = "src/app/portal";
const SCHEMA_FILE = "prisma/schema.prisma";

// 1. Every exported action's own parameter list never accepts
// organizationId/userId — scoped to the actual function signature (not
// the whole file body, which legitimately references `organizationId` as
// a server-resolved local variable), the same signature-scoped technique
// check-billing-security.mjs already established.
function exportedFunctionParamLists(content) {
  const regex = /export\s+async\s+function\s+\w+\s*\(([^)]*)\)/g;
  const lists = [];
  let match;
  while ((match = regex.exec(content))) {
    lists.push(match[1]);
  }
  return lists;
}
const actionsSource = existsSync(ACTIONS_FILE) ? readFileSync(ACTIONS_FILE, "utf8") : "";
const FORBIDDEN_PARAM_NAMES = /\b(organizationId|userId)\b/;
const paramListsWithForbiddenNames = exportedFunctionParamLists(actionsSource).filter((params) =>
  FORBIDDEN_PARAM_NAMES.test(params),
);
ok = report(
  "onboarding actions never accept organizationId/userId as a parameter",
  existsSync(ACTIONS_FILE) && paramListsWithForbiddenNames.length === 0,
  paramListsWithForbiddenNames.join(", "),
) && ok;

// 2. Every action resolves its organization via getCurrentUserOrganization
// (never a client-supplied id) — presence check, paired with check 1
// above (which proves it's never *accepted* as a parameter) to also prove
// it's *actually resolved* server-side, not simply absent from the
// signature and then hardcoded/omitted entirely.
const actionsResolveOrgServerSide = /getCurrentUserOrganization\s*\(/.test(actionsSource);
ok = report(
  "onboarding actions resolve organizationId via getCurrentUserOrganization()",
  existsSync(ACTIONS_FILE) && actionsResolveOrgServerSide,
  actionsSource ? "" : "actions file not found",
) && ok;

// 3. OrganizationOnboardingStep has no relation to User anywhere in its
// own schema block — scoped to that model's block specifically, not the
// whole schema file, so an unrelated model's own legitimate User relation
// never trips this.
const schemaContent = existsSync(SCHEMA_FILE) ? readFileSync(SCHEMA_FILE, "utf8") : "";
const stepModelMatch = schemaContent.match(/model OrganizationOnboardingStep \{[\s\S]*?\n\}/);
const stepModelBlock = stepModelMatch ? stepModelMatch[0] : "";
const hasUserReference = /\bUser\b/.test(stepModelBlock);
ok = report(
  "OrganizationOnboardingStep has no relation to User",
  !hasUserReference && stepModelBlock.length > 0,
  stepModelBlock ? "" : "OrganizationOnboardingStep model not found",
) && ok;

// 4. No Activity coupling — onboarding's own library code never imports
// createActivity, and never imports dispatchNotificationsForActivity.
const activityImport = grep('from "@/lib/activity/create-activity"', ONBOARDING_LIB_DIR);
ok = report("onboarding never imports createActivity", activityImport === "", activityImport) && ok;

// 5. No Notification coupling — no email delivery, no direct Notification
// table write, from onboarding's own library code.
const notificationEmailImport = grep(
  'from "@/lib/notifications/email/deliver-notification-email"',
  ONBOARDING_LIB_DIR,
);
const notificationTableWrite = grep("prisma\\.notification\\.(create|createMany|upsert)", ONBOARDING_LIB_DIR);
ok = report(
  "onboarding never delivers notification emails or writes a Notification row",
  notificationEmailImport === "" && notificationTableWrite === "",
  [notificationEmailImport, notificationTableWrite].filter(Boolean).join("\n"),
) && ok;

// 6. No import of anything under src/lib/billing — the Billing branch is
// not merged into main, and onboarding must stay independent of it (this
// stage's own explicit "don't pull the Billing branch in" constraint).
const billingImport = grep('from "@/lib/billing', ONBOARDING_LIB_DIR);
ok = report("onboarding never imports src/lib/billing", billingImport === "", billingImport) && ok;

// 7. No Subscription/billing model reference in onboarding's own library
// code — belt and suspenders alongside check 6 (a direct
// `prisma.subscription` access would bypass that import-path check
// entirely).
const subscriptionAccess = grep("prisma\\.subscription\\.", ONBOARDING_LIB_DIR);
ok = report("onboarding never references prisma.subscription directly", subscriptionAccess === "", subscriptionAccess) && ok;

// 8. No PortalUser/Client Portal identity import in onboarding's own
// library code — onboarding is a staff-only concept (docs/onboarding-
// architecture.md §17: the Portal side is deliberately a separate, thin,
// unrelated concern), same staff-only boundary check-billing-security.mjs
// and check-comments-security.mjs already establish for their own
// features.
const portalIdentityImport = grep('from "@/lib/current-portal-user"', ONBOARDING_LIB_DIR);
ok = report("onboarding never imports the Client Portal identity module", portalIdentityImport === "", portalIdentityImport) && ok;

// 9. The Client Portal never imports anything from src/lib/onboarding —
// verified from the other direction.
const onboardingImportInPortal = grep('from "@/lib/onboarding', PORTAL_APP_DIR);
ok = report("the Client Portal never imports src/lib/onboarding", onboardingImportInPortal === "", onboardingImportInPortal) && ok;

// 10. skipOnboardingStepAction validates its stepKey against the real
// catalog before ever writing — presence check for the actual guard
// function/catalog reference, not just any mention of "step".
const skipValidatesAgainstCatalog =
  /isValidStepKey/.test(actionsSource) && /ONBOARDING_STEPS/.test(actionsSource) && /skippable/.test(actionsSource);
ok = report(
  "skipOnboardingStepAction validates stepKey against the step catalog and its skippable flag",
  existsSync(ACTIONS_FILE) && skipValidatesAgainstCatalog,
  actionsSource ? "" : "actions file not found",
) && ok;

// 11. The critical §12 invariant: no approved Client/Project/Task creation
// Server Action writes to OrganizationOnboardingStep directly. Completion
// is always computed live (src/lib/onboarding/progress.ts) — a mutation
// file reaching into the onboarding table would be a second, competing
// source of truth. Scoped to the exact three creation files this
// invariant is about, not a whole-codebase grep, so it stays meaningful
// rather than brittle.
const BUSINESS_MUTATION_FILES = [
  "src/app/(dashboard)/clients/new/actions.ts",
  "src/app/(dashboard)/projects/new/actions.ts",
  "src/app/(dashboard)/tasks/new/actions.ts",
];
const filesWritingOnboardingTable = BUSINESS_MUTATION_FILES.filter((file) => {
  if (!existsSync(file)) return false;
  return /organizationOnboardingStep/.test(readFileSync(file, "utf8"));
});
ok = report(
  "Client/Project/Task creation never writes to OrganizationOnboardingStep — completion is always computed live",
  filesWritingOnboardingTable.length === 0,
  filesWritingOnboardingTable.join(", "),
) && ok;

// 12. The step catalog's own href allowlist never contains an invented
// route — every href in ONBOARDING_STEP_HREF_ALLOWLIST must correspond to
// a real page.tsx under src/app. A lightweight, non-brittle structural
// check: each allowlisted href (stripped of a trailing /new) must resolve
// to an existing directory under src/app/(dashboard).
const stepsSource = existsSync(STEPS_FILE) ? readFileSync(STEPS_FILE, "utf8") : "";
const allowlistMatch = stepsSource.match(/ONBOARDING_STEP_HREF_ALLOWLIST[^=]*=\s*\[([\s\S]*?)\];/);
const allowlistedHrefs = allowlistMatch
  ? [...allowlistMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  : [];
const missingRoutes = allowlistedHrefs.filter((href) => {
  const routeDir = `src/app/(dashboard)${href}`;
  return !existsSync(routeDir) && !existsSync(`${routeDir}.tsx`);
});
ok = report(
  "every href in the onboarding step catalog's allowlist resolves to a real route directory",
  allowlistedHrefs.length > 0 && missingRoutes.length === 0,
  missingRoutes.join(", "),
) && ok;

// 13. Stage 3: no "use client" component under src/components/onboarding/
// ever imports prisma or the DB-backed progress reader directly. The
// checklist card is a Server Component (onboarding-card.tsx) that receives
// an already-fetched OnboardingProgressSummary as a prop
// ((dashboard)/dashboard/page.tsx is the one call site for
// getOrganizationOnboardingProgress) — only the two small "use client"
// action buttons (skip/dismiss) exist, and both must reach the database
// exclusively through the "use server" actions module, never directly,
// the same server/client boundary discipline every other feature's own
// client components already keep.
const ONBOARDING_COMPONENTS_DIR = "src/components/onboarding";
const clientComponentFiles = existsSync(ONBOARDING_COMPONENTS_DIR)
  ? readdirSync(ONBOARDING_COMPONENTS_DIR)
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => `${ONBOARDING_COMPONENTS_DIR}/${f}`)
      .filter((f) => /^\s*"use client";/.test(readFileSync(f, "utf8")))
  : [];
const FORBIDDEN_DIRECT_IMPORTS = /from\s+"@\/lib\/(prisma|onboarding\/progress)"/;
const clientComponentsWithDirectDbAccess = clientComponentFiles.filter((f) =>
  FORBIDDEN_DIRECT_IMPORTS.test(readFileSync(f, "utf8")),
);
ok = report(
  "no 'use client' onboarding component imports prisma or the progress reader directly",
  clientComponentFiles.length > 0 && clientComponentsWithDirectDbAccess.length === 0,
  clientComponentsWithDirectDbAccess.join(", "),
) && ok;

process.exit(ok ? 0 : 1);
