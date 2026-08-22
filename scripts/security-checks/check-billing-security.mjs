import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { grep, report } from "./lib.mjs";

// Billing & Subscriptions Stage 2 (docs/billing-architecture.md, and this
// stage's own explicit "provider-neutral" contract). No provider is
// connected at runtime in this stage — every check here targets a way
// that boundary could quietly weaken, or a way this stage's own
// enforcement wiring could silently regress, the same discipline as
// check-search-security.mjs/check-cron-security.mjs for their own
// features.

let ok = true;

const BILLING_LIB_DIR = "src/lib/billing";
const PORTAL_APP_DIR = "src/app/portal";
const SCHEMA_FILE = "prisma/schema.prisma";

// 1. No Paddle/Stripe SDK dependency OTHER than the two official packages
// this app actually uses. Stages 1-4's original rule ("no SDK at all")
// was correct while this was genuinely provider-neutral with no provider
// chosen; Sale-Ready Phase E, E2.3 narrowed this to allow the one
// server-side package a real adapter needs (@paddle/paddle-node-sdk); E2.5
// (Paddle Checkout UX / Hosted Checkout Bridge) adds the one official
// client-side package the checkout bridge page needs (@paddle/paddle-js)
// — a stray Stripe package, a second/competing Paddle package, or a
// typosquatted lookalike is still rejected outright.
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies };
const ALLOWED_PROVIDER_SDK_PACKAGES = ["@paddle/paddle-node-sdk", "@paddle/paddle-js"];
const providerSdkDeps = Object.keys(allDeps).filter((name) => /paddle|stripe/i.test(name));
const unexpectedProviderSdkDeps = providerSdkDeps.filter((name) => !ALLOWED_PROVIDER_SDK_PACKAGES.includes(name));
ok = report(
  `no Paddle/Stripe SDK dependency other than ${ALLOWED_PROVIDER_SDK_PACKAGES.join(" or ")}`,
  unexpectedProviderSdkDeps.length === 0,
  unexpectedProviderSdkDeps.join(", "),
) && ok;

// 2. The server-side Paddle Node SDK (@paddle/paddle-node-sdk) is only
// ever imported from src/lib/billing/provider/ — never from a "use
// client" file, never from the Billing UI tree
// (src/app/(dashboard)/settings/billing), never from the Client Portal,
// never from anywhere else in src/app or src/lib. A blanket "no import
// anywhere in src/" ban (the original Stage 1-4 rule) is no longer
// correct now that a real adapter genuinely does import the SDK; this is
// the narrower, still-meaningful replacement — the SDK (and,
// transitively, the server-side API key it's constructed with) must
// never reach a client bundle or any code path outside the
// provider-adapter boundary. Sale-Ready Phase E, E2.5 scopes this check
// to exactly this one server-side package — @paddle/paddle-js (the
// client-side wrapper E2.5 adds) has its own, separate checks (27-28
// below), since it's expected to live in a completely different
// location by design.
const PROVIDER_DIR_PREFIX = "src/lib/billing/provider/";
const serverSdkImportLines = grep('from "@paddle/paddle-node-sdk"', "src")
  .split("\n")
  .filter(Boolean);
const serverSdkImportsOutsideProviderDir = serverSdkImportLines.filter((line) => !line.startsWith(PROVIDER_DIR_PREFIX));
ok = report(
  "the Paddle Node SDK (@paddle/paddle-node-sdk) is only ever imported from src/lib/billing/provider/, never anywhere else in src/",
  serverSdkImportsOutsideProviderDir.length === 0,
  serverSdkImportsOutsideProviderDir.join(", "),
) && ok;

// 3. No NEXT_PUBLIC_*-prefixed billing/provider env var referenced
// anywhere — a provider price id, publishable key, or customer-portal
// token must never be client-exposed, and Stage 2 doesn't read any real
// provider env var at all (price IDs are explicitly deferred to Stage 3+,
// docs/billing-architecture.md §6). Sale-Ready Phase E, E2.5 adds exactly
// one narrow, deliberate exception: NEXT_PUBLIC_BILLING_CLIENT_TOKEN —
// Paddle's own dedicated, documented-as-client-safe "client-side token"
// (see .env.example's own comment on this variable for the full
// reasoning). Every other billing/provider variable (a provider price
// id, the server-side API key, the webhook secret, or any future one)
// stays banned with a NEXT_PUBLIC_ prefix.
const ALLOWED_PUBLIC_BILLING_ENV_VAR = "NEXT_PUBLIC_BILLING_CLIENT_TOKEN";
// Exact identifier match, not a substring check — `.includes()` would
// also silently allow a differently-named variant like
// NEXT_PUBLIC_BILLING_CLIENT_TOKEN_2 or NEXT_PUBLIC_BILLING_CLIENT_TOKEN_LEAK
// just because it happens to contain the allowed name. `_` counts as a
// \w character in JS regex, so `\b` only matches at a genuine identifier
// boundary (a quote, a dot, whitespace, etc.) — it correctly rejects
// both a suffixed and a prefixed variant while still matching every real
// reference (`process.env.NEXT_PUBLIC_BILLING_CLIENT_TOKEN`,
// `"NEXT_PUBLIC_BILLING_CLIENT_TOKEN"`, ...).
const ALLOWED_PUBLIC_BILLING_ENV_VAR_PATTERN = new RegExp(`\\b${ALLOWED_PUBLIC_BILLING_ENV_VAR}\\b`);
const publicBillingEnvVarLines = grep("NEXT_PUBLIC_[A-Z_]*(PADDLE|STRIPE|BILLING|PRICE)", "src")
  .split("\n")
  .filter(Boolean);
const unexpectedPublicBillingEnvVarLines = publicBillingEnvVarLines.filter(
  (line) => !ALLOWED_PUBLIC_BILLING_ENV_VAR_PATTERN.test(line),
);
ok = report(
  `no NEXT_PUBLIC billing/provider env var referenced anywhere, other than ${ALLOWED_PUBLIC_BILLING_ENV_VAR}`,
  unexpectedPublicBillingEnvVarLines.length === 0,
  unexpectedPublicBillingEnvVarLines.join(", "),
) && ok;

// 4. Billing helpers are never imported from the Client Portal's own app
// tree — billing is a staff-only concept end to end (docs/billing-
// architecture.md §8's own "Portal UI is not touched" rule); a Portal
// route importing anything from src/lib/billing would be the first sign
// of that boundary blurring, the same shape as check-search-security.mjs's
// own "no Client Portal import in the search backend" check, mirrored in
// the other direction.
const billingImportInPortal = grep('from "@/lib/billing', PORTAL_APP_DIR);
ok = report("billing helpers are never imported by the Client Portal UI", billingImportInPortal === "", billingImportInPortal) && ok;

// 5. Provider ids/keys never appear in a "use client" file — a
// providerCustomerId/providerSubscriptionId/API key must stay server-only.
// Scans every "use client" file in the app for the two Subscription
// column names that would only ever matter to a server-side caller.
function findClientComponentFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findClientComponentFiles(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      const content = readFileSync(full, "utf8");
      if (content.startsWith('"use client"') || content.startsWith("'use client'")) {
        out.push(full);
      }
    }
  }
  return out;
}
const clientComponentFiles = existsSync("src") ? findClientComponentFiles("src") : [];
const clientFilesWithProviderIds = clientComponentFiles.filter((file) => {
  const content = readFileSync(file, "utf8");
  return /providerCustomerId|providerSubscriptionId|providerEventId/.test(content);
});
ok = report(
  "no provider id field referenced in any client (\"use client\") module",
  clientFilesWithProviderIds.length === 0,
  clientFilesWithProviderIds.join(", "),
) && ok;

// 6. Entitlement checks are present in exactly the approved Stage 2
// mutation paths — a regression here (someone removing the import while
// refactoring one of these files) would silently re-open the limit this
// stage exists to close. Checks for the actual assert* import, not just
// any mention of "billing", so a stray comment can't produce a false pass.
const ENFORCEMENT_CALL_SITES = [
  { file: "src/app/(dashboard)/team/actions.ts", assertion: "assertCanInviteMember" },
  { file: "src/app/(dashboard)/clients/new/actions.ts", assertion: "assertCanCreateClient" },
  { file: "src/app/(dashboard)/projects/new/actions.ts", assertion: "assertCanCreateProject" },
  { file: "src/lib/attachments/attachment-mutations.ts", assertion: "assertCanUploadAttachment" },
];
const missingEnforcement = ENFORCEMENT_CALL_SITES.filter(({ file, assertion }) => {
  if (!existsSync(file)) return true;
  const content = readFileSync(file, "utf8");
  return !content.includes(`@/lib/billing/enforcement`) || !content.includes(assertion);
});
ok = report(
  "entitlement checks are present in every approved Stage 2 mutation path",
  missingEnforcement.length === 0,
  missingEnforcement.map((m) => m.file).join(", "),
) && ok;

// 7. WebhookEvent never gains a raw/summary payload column — Stage 2's own
// explicit "no raw webhook payload" rule (docs/billing-architecture.md §5,
// reaffirmed by this stage's own instructions). Scoped to the
// WebhookEvent model block specifically, not the whole schema file, so an
// unrelated model's own legitimately-named column never trips this.
const schemaContent = readFileSync(SCHEMA_FILE, "utf8");
const webhookEventBlockMatch = schemaContent.match(/model WebhookEvent \{[\s\S]*?\n\}/);
const webhookEventBlock = webhookEventBlockMatch ? webhookEventBlockMatch[0] : "";
const hasPayloadColumn = /payload/i.test(webhookEventBlock);
ok = report("WebhookEvent has no raw/summary payload column", !hasPayloadColumn && webhookEventBlock.length > 0, webhookEventBlock ? "" : "WebhookEvent model not found") && ok;

// 8. Nothing under src/lib/billing imports the Client Portal identity
// module — same staff-only boundary as check 4, verified from the other
// direction.
const portalImportInBilling = grep('from "@/lib/current-portal-user"', BILLING_LIB_DIR);
ok = report("no Client Portal import anywhere in src/lib/billing", portalImportInBilling === "", portalImportInBilling) && ok;

// Billing & Subscriptions Stage 3 (this stage's own §15) — 5 additional
// checks, appended rather than replacing anything above.

const BILLING_UI_DIRS = ["src/app/(dashboard)/settings/billing", "src/components/billing"];
const BILLING_ACTIONS_FILE = "src/app/(dashboard)/settings/billing/actions.ts";

// 9. The Billing page/component tree itself never imports a Paddle/Stripe
// SDK — a scoped, targeted variant of check 2 above (which already covers
// all of src/), called out separately because this stage's own instructions
// name the billing UI specifically.
const billingUiProviderImports = BILLING_UI_DIRS.filter(existsSync)
  .map((dir) => grep('from "(@paddle|@stripe|paddle-|stripe)', dir))
  .join("");
ok = report(
  "the Billing page/component tree never imports a Paddle/Stripe SDK",
  billingUiProviderImports === "",
  billingUiProviderImports,
) && ok;

// 10. "use client" billing components never import server-only billing
// internals directly — the only sanctioned client -> server boundary is the
// "use server" actions file (src/app/(dashboard)/settings/billing/actions.ts),
// never src/lib/billing/* directly from a client bundle.
function findClientFilesUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findClientFilesUnder(full));
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      const content = readFileSync(full, "utf8");
      if (content.startsWith('"use client"') || content.startsWith("'use client'")) {
        out.push(full);
      }
    }
  }
  return out;
}
// Type-only imports (`import type { X } from "@/lib/billing/..."`) compile
// away entirely and carry no runtime risk — a client component importing
// just the PlanKey string-literal type is fine; only a value import would
// pull real billing logic into the client bundle.
const billingClientFiles = BILLING_UI_DIRS.flatMap(findClientFilesUnder);
const clientFilesImportingBillingLib = billingClientFiles.filter((file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .some((line) => /from ["']@\/lib\/billing\//.test(line) && !/^\s*import\s+type\b/.test(line)),
);
ok = report(
  "\"use client\" billing components never import src/lib/billing/* directly (only via the Server Action boundary, or a type-only import)",
  clientFilesImportingBillingLib.length === 0,
  clientFilesImportingBillingLib.join(", "),
) && ok;

// 11. Every checkout/portal Server Action — the real ones (this stage's
// own actions.ts) and the TEST_MODE-only mock ones (src/app/billing/mock/
// */actions.ts) — resolves organization/role/provider ids server-side
// only. Scoped to each EXPORTED FUNCTION'S OWN PARAMETER LIST specifically
// (not the whole file — Stage 4's real actions legitimately reference
// `organizationId`/`providerCustomerId` in their *bodies*, resolved from
// getCurrentMembership()/a DB read, never accepted as input). A function
// signature containing one of these identifiers as a parameter would mean
// a caller could supply it directly instead.
function exportedFunctionParamLists(content) {
  const regex = /export\s+async\s+function\s+\w+\s*\(([^)]*)\)/g;
  const lists = [];
  let match;
  while ((match = regex.exec(content))) {
    lists.push(match[1]);
  }
  return lists;
}
const CLIENT_SUPPLIED_ID_ACTION_FILES = [
  BILLING_ACTIONS_FILE,
  "src/app/billing/mock/checkout/actions.ts",
  "src/app/billing/mock/portal/actions.ts",
];
const FORBIDDEN_PARAM_NAMES = /\b(organizationId|userId|providerCustomerId|providerSubscriptionId)\b/;
const filesWithClientSuppliedIdParams = CLIENT_SUPPLIED_ID_ACTION_FILES.filter((file) => {
  if (!existsSync(file)) return true;
  const content = readFileSync(file, "utf8");
  return exportedFunctionParamLists(content).some((params) => FORBIDDEN_PARAM_NAMES.test(params));
});
ok = report(
  "checkout/portal actions (real and mock) never accept organizationId/userId/providerCustomerId/providerSubscriptionId as a parameter",
  filesWithClientSuppliedIdParams.length === 0,
  filesWithClientSuppliedIdParams.join(", "),
) && ok;

// 12. The checkout/portal actions have no side effect on Subscription/
// WebhookEvent themselves — only the webhook route ever writes either
// table (this stage's own §5/§6: "no DB mutation until webhook"). A
// regression here would mean an action started mutating billing state
// directly instead of only ever redirecting the browser.
const actionsSource = existsSync(BILLING_ACTIONS_FILE) ? readFileSync(BILLING_ACTIONS_FILE, "utf8") : "";
const actionsCodeOnly = actionsSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const mutatesSubscriptionOrWebhook = /\.subscription\.(update|create|upsert|delete)|\.webhookEvent\.(update|create|upsert|delete)/.test(
  actionsCodeOnly,
);
ok = report(
  "checkout/portal actions never mutate Subscription or WebhookEvent directly",
  existsSync(BILLING_ACTIONS_FILE) && !mutatesSubscriptionOrWebhook,
  mutatesSubscriptionOrWebhook ? BILLING_ACTIONS_FILE : "actions file not found",
) && ok;

// 13. The Client Portal never imports any part of the Billing UI —
// same staff-only boundary as check 4 (which covers src/lib/billing),
// extended to also cover the TEST_MODE-only mock checkout/portal pages
// this stage adds.
const billingUiImportInPortal = grep(
  'from "@/components/billing|from "@/app/\\(dashboard\\)/settings/billing|from "@/app/billing',
  PORTAL_APP_DIR,
);
ok = report("the Client Portal never imports the Billing UI", billingUiImportInPortal === "", billingUiImportInPortal) && ok;

// Billing & Subscriptions Stage 4 (this stage's own §16) — 10 additional
// checks, appended rather than replacing anything above.

const PROVIDER_DIR = "src/lib/billing/provider";
const WEBHOOK_ROUTE_FILE = "src/app/api/billing/webhook/route.ts";
const MOCK_PROVIDER_FILE = "src/lib/billing/provider/mock-provider.ts";
const EVENT_MAPPER_FILE = "src/lib/billing/event-mapper.ts";
const MOCK_CHECKOUT_PAGE = "src/app/billing/mock/checkout/page.tsx";
const MOCK_PORTAL_PAGE = "src/app/billing/mock/portal/page.tsx";

// 14. Every provider adapter file is server-only.
function listFilesRecursive(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}
const providerFiles = listFilesRecursive(PROVIDER_DIR);
const providerFilesMissingServerOnly = providerFiles.filter(
  (file) => !readFileSync(file, "utf8").includes('import "server-only"'),
);
ok = report(
  "every file under src/lib/billing/provider/ imports \"server-only\"",
  providerFiles.length > 0 && providerFilesMissingServerOnly.length === 0,
  providerFilesMissingServerOnly.join(", "),
) && ok;

// 15. No console logging in the webhook route or the provider adapter
// directory — a raw payload, signature, or provider secret must never
// reach a log line, even accidentally via a generic console.log(event)
// during debugging that was left in.
const consoleInWebhookPath = [WEBHOOK_ROUTE_FILE, PROVIDER_DIR]
  .filter(existsSync)
  .map((target) => grep("console\\.(log|error|warn|info|debug)", target))
  .join("");
ok = report(
  "no console logging in the billing webhook route or provider adapter directory",
  consoleInWebhookPath === "",
  consoleInWebhookPath,
) && ok;

// 16. The webhook route verifies the signature unconditionally, before
// ever parsing the payload, and has no TEST_MODE-gated bypass of its own
// (TEST_MODE only ever changes which *adapter* the registry resolves to —
// see src/lib/billing/provider/provider.ts — never the route's own logic).
const webhookRouteSource = existsSync(WEBHOOK_ROUTE_FILE) ? readFileSync(WEBHOOK_ROUTE_FILE, "utf8") : "";
const verifyIndex = webhookRouteSource.indexOf("verifyWebhook(");
const parseIndex = webhookRouteSource.indexOf("parseWebhookEvent(");
const verifiesBeforeParsing = verifyIndex !== -1 && parseIndex !== -1 && verifyIndex < parseIndex;
const webhookRouteReferencesTestMode = /\bTEST_MODE\b/.test(webhookRouteSource);
ok = report(
  "the webhook route verifies the signature before parsing, with no TEST_MODE bypass of its own",
  verifiesBeforeParsing && !webhookRouteReferencesTestMode,
  !verifiesBeforeParsing ? "verifyWebhook does not run before parseWebhookEvent" : "route references TEST_MODE directly",
) && ok;

// 17. Idempotency relies on the database's own unique constraint (a real
// P2002 catch), not a check-then-insert race — see this file's own §7
// requirement and the route's own header comment for why.
const webhookHasP2002Dedup = /P2002/.test(webhookRouteSource) && /providerEventId/.test(webhookRouteSource);
ok = report(
  "the webhook route dedupes via a P2002 unique-constraint catch on providerEventId",
  webhookHasP2002Dedup,
  webhookRouteSource ? "" : "webhook route not found",
) && ok;

// 18. The event mapper implements an explicit old-event/ordering guard —
// an event whose own providerUpdatedAt doesn't advance the row's last-
// applied one must never overwrite newer state.
const mapperSource = existsSync(EVENT_MAPPER_FILE) ? readFileSync(EVENT_MAPPER_FILE, "utf8") : "";
const mapperHasOrderingGuard = /providerUpdatedAt/.test(mapperSource) && /IGNORE_OLDER_EVENT/.test(mapperSource);
ok = report(
  "the event mapper implements an explicit providerUpdatedAt ordering guard",
  mapperHasOrderingGuard,
  mapperSource ? "" : "event mapper not found",
) && ok;

// 19. Checkout/portal actions are OWNER-only — every exported action in
// the real actions file checks membership.role against Role.OWNER.
const ownerCheckCount = (actionsSource.match(/membership\.role\s*!==\s*Role\.OWNER/g) ?? []).length;
ok = report(
  "requestPlanChangeAction and manageSubscriptionAction both check OWNER role",
  ownerCheckCount >= 2,
  `found ${ownerCheckCount} OWNER check(s), expected at least 2`,
) && ok;

// 20. Checkout/portal return/cancel URLs are only ever built through
// sanitizeRedirectPath — never a raw, unvalidated string handed to an
// adapter or a redirect() call.
const actionsUseSafeRedirect = /sanitizeRedirectPath/.test(actionsSource);
ok = report("checkout/portal return URLs are built via sanitizeRedirectPath", actionsUseSafeRedirect, actionsSource ? "" : "actions file not found") && ok;

// 21. The mock provider is unreachable outside TEST_MODE (throws at
// construction), and both mock UI pages 404 outside TEST_MODE before
// doing anything else — the same "fail closed, checked first" shape
// src/app/api/e2e-test-storage/[...path]/route.ts already established.
const mockProviderSource = existsSync(MOCK_PROVIDER_FILE) ? readFileSync(MOCK_PROVIDER_FILE, "utf8") : "";
const mockProviderGatesOnTestMode = /if\s*\(\s*!TEST_MODE\s*\)/.test(mockProviderSource);
const mockPagesGateOnTestMode = [MOCK_CHECKOUT_PAGE, MOCK_PORTAL_PAGE].every((file) => {
  if (!existsSync(file)) return false;
  const content = readFileSync(file, "utf8");
  return /if\s*\(\s*!TEST_MODE\s*\)/.test(content) && /notFound\(\)/.test(content);
});
ok = report(
  "the mock provider and both mock UI pages are unreachable outside TEST_MODE",
  mockProviderGatesOnTestMode && mockPagesGateOnTestMode,
  `mock-provider.ts gate: ${mockProviderGatesOnTestMode}, mock pages gate: ${mockPagesGateOnTestMode}`,
) && ok;

// 22. No real-looking provider price/product id literal hardcoded
// anywhere in src/ — this stage never reads a real price id from
// anywhere (see .env.example's own placeholder-only BILLING_*_PRICE_ID
// entries), so a literal matching a real Paddle/Stripe id shape appearing
// in source would mean one was pasted in by mistake.
const hardcodedPriceIds = grep('"(pri_|price_)[A-Za-z0-9]', "src");
ok = report("no hardcoded provider price/product id literal anywhere in src/", hardcodedPriceIds === "", hardcodedPriceIds) && ok;

// 23. Organization/provider-id trust validation is present in the webhook
// route — an unknown organization or a provider id already bound to a
// different org must be rejected, never silently applied.
const webhookHasTrustChecks =
  /unknown_organization/.test(webhookRouteSource) && /provider_id_conflict/.test(webhookRouteSource);
ok = report(
  "the webhook route validates organization existence and rejects cross-org provider id reuse",
  webhookHasTrustChecks,
  webhookRouteSource ? "" : "webhook route not found",
) && ok;

// Sale-Ready Phase E, E2.3 (Paddle Provider Core — checkout + customer
// portal only) — 1 additional check, appended rather than replacing
// anything above.

// 24. The provider registry activates the real Paddle adapter only
// through getPaddleProviderConfig() — never a hardcoded or
// independently-assembled config. E2.3-E2.5 built createPaddleBillingProvider()
// without wiring it into getBillingProviderAdapter(); E2.6 (Paddle
// Provider Resolver Activation) is the PR that deliberately does wire it
// in — this check's own original text ("the registry does not yet
// reference createPaddleBillingProvider") was written expecting exactly
// this PR to flip it, per its own prior comment. Now that it's wired in,
// the check's job changes from "prove it's NOT referenced" to "prove
// it's referenced only the one safe way": both `createPaddleBillingProvider`
// and `getPaddleProviderConfig` must be referenced, and
// `createPaddleBillingProvider` must never be called with an inline
// object literal (`createPaddleBillingProvider({...})`) — the only
// argument it's ever given must be whatever `getPaddleProviderConfig()`
// itself returned, never a hand-assembled or partially-filled substitute.
// Further resolver-specific checks (env-read discipline, TEST_MODE
// ordering, the unconfigured fallback, no network calls) are their own,
// more specific checks appended at the end of this file (E2.6 section).
const PROVIDER_REGISTRY_FILE = "src/lib/billing/provider/provider.ts";
const providerRegistrySource = existsSync(PROVIDER_REGISTRY_FILE) ? readFileSync(PROVIDER_REGISTRY_FILE, "utf8") : "";
// Comment-stripped variant — same shape as check 12's own `actionsCodeOnly`
// above — used only by the checks below that would otherwise false-positive
// on this file's own doc comments (which legitimately name BILLING_* env
// vars and mention "await"/"fetch" in prose while documenting exactly why
// the real code never does either).
const providerRegistryCodeOnly = providerRegistrySource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const registryActivatesPaddleOnlyViaConfig =
  /createPaddleBillingProvider/.test(providerRegistrySource) &&
  /getPaddleProviderConfig/.test(providerRegistrySource) &&
  !/createPaddleBillingProvider\(\s*\{/.test(providerRegistrySource);
ok = report(
  "the provider registry activates the real Paddle adapter only via getPaddleProviderConfig(), never an inline/hardcoded config",
  providerRegistrySource !== "" && registryActivatesPaddleOnlyViaConfig,
  providerRegistrySource === "" ? "provider registry file not found" : "registry does not reference both createPaddleBillingProvider and getPaddleProviderConfig, or calls createPaddleBillingProvider with an inline object literal",
) && ok;

// Sale-Ready Phase E, E2.4 (Paddle Webhook Verification + Event
// Normalization) — 2 additional checks, appended rather than replacing
// anything above. Both are regression guards against silently reverting
// to E2.3's safe-but-inert placeholders (`verified: false,
// reason: "not_implemented"` / always `null`) — a real, non-placeholder
// implementation is required now that this PR adds one, the same
// "guard against a silent regression back to the safe default" shape as
// check 24 above.

const PADDLE_PROVIDER_FILE = "src/lib/billing/provider/paddle-provider.ts";
const paddleProviderSource = existsSync(PADDLE_PROVIDER_FILE) ? readFileSync(PADDLE_PROVIDER_FILE, "utf8") : "";

// 25. verifyWebhook is a real HMAC-SHA256 implementation (node:crypto),
// not the E2.3 "always verified: false" placeholder.
const verifyWebhookIsReal =
  /createHmac\(\s*["']sha256["']/.test(paddleProviderSource) &&
  /timingSafeEqual/.test(paddleProviderSource) &&
  !/return \{\s*verified:\s*false,\s*reason:\s*"not_implemented"\s*\}/.test(paddleProviderSource);
ok = report(
  "paddle-provider.ts's verifyWebhook is a real HMAC-SHA256 implementation, not the E2.3 placeholder",
  verifyWebhookIsReal,
  paddleProviderSource ? "" : "paddle-provider.ts not found",
) && ok;

// 26. parseWebhookEvent is a real implementation — parses the raw body as
// JSON and normalizes known subscription events, not the E2.3 "always
// null" placeholder.
const parseWebhookEventIsReal =
  /JSON\.parse\(rawBody\)/.test(paddleProviderSource) &&
  /SUBSCRIPTION_CREATED/.test(paddleProviderSource) &&
  !/void rawBody;[\s\S]{0,120}return null;/.test(paddleProviderSource);
ok = report(
  "paddle-provider.ts's parseWebhookEvent is a real implementation, not the E2.3 placeholder",
  parseWebhookEventIsReal,
  paddleProviderSource ? "" : "paddle-provider.ts not found",
) && ok;

// Sale-Ready Phase E, E2.5 (Paddle Checkout UX / Hosted Checkout Bridge)
// — 3 additional checks, appended rather than replacing anything above.
// E2.5 adds a second, client-side Paddle SDK (@paddle/paddle-js) and its
// own bridge page — checks 1-3 above were narrowed in place to allow it,
// and these three cover the parts of its own boundary that don't fit
// naturally into any existing check.

const CHECKOUT_BRIDGE_DIR_PREFIX = "src/app/billing/checkout/";
const clientSdkImportLines = grep('from "@paddle/paddle-js"', "src")
  .split("\n")
  .filter(Boolean);

// 27. @paddle/paddle-js is only ever imported from
// src/app/billing/checkout/ (the checkout bridge page) — never from
// src/lib/billing/provider/ (which must stay server-only per check 14
// above), never from the Billing UI tree, never anywhere else. Also
// requires it to actually be imported somewhere (the same "not silently
// removed" regression-guard shape as check 14's own
// `providerFiles.length > 0`) — a change that removes the only import
// while leaving the dependency in package.json (or vice versa) is
// exactly the kind of drift this check exists to catch.
const clientSdkImportsOutsideBridgeDir = clientSdkImportLines.filter((line) => !line.startsWith(CHECKOUT_BRIDGE_DIR_PREFIX));
ok = report(
  "@paddle/paddle-js is only ever imported from src/app/billing/checkout/, never anywhere else in src/",
  clientSdkImportLines.length > 0 && clientSdkImportsOutsideBridgeDir.length === 0,
  clientSdkImportLines.length === 0 ? "@paddle/paddle-js is not imported anywhere" : clientSdkImportsOutsideBridgeDir.join(", "),
) && ok;

// 28. Every file that imports @paddle/paddle-js is itself a "use client"
// file — the client-side wrapper must never be pulled into a Server
// Component/Server Action bundle by accident (harmless either way
// content-wise — it carries no secret — but "use client"-only is the
// correct, intentional boundary for a browser-only library).
const clientSdkImportingFiles = [...new Set(clientSdkImportLines.map((line) => line.split(":")[0]))];
const clientSdkFilesMissingUseClient = clientSdkImportingFiles.filter((file) => {
  if (!existsSync(file)) return true;
  const content = readFileSync(file, "utf8");
  return !(content.startsWith('"use client"') || content.startsWith("'use client'"));
});
ok = report(
  'every file importing @paddle/paddle-js starts with "use client"',
  clientSdkFilesMissingUseClient.length === 0,
  clientSdkFilesMissingUseClient.join(", "),
) && ok;

// 29. BILLING_API_KEY and BILLING_WEBHOOK_SECRET — this app's two real
// server-only secrets — are never referenced by name in any "use
// client" file, a stricter, name-specific check than check 3 above
// (which only catches a NEXT_PUBLIC_ prefix; a secret referenced in
// client code without that prefix would still ship it straight into the
// browser bundle and wouldn't trip check 3 at all). Reuses
// findClientComponentFiles() (defined above, check 5's own helper) — a
// hoisted function declaration, safe to call from here regardless of
// this check's own position in the file.
const clientFilesReferencingServerSecretNames = (existsSync("src") ? findClientComponentFiles("src") : []).filter((file) => {
  const content = readFileSync(file, "utf8");
  return /BILLING_API_KEY|BILLING_WEBHOOK_SECRET/.test(content);
});
ok = report(
  'BILLING_API_KEY/BILLING_WEBHOOK_SECRET are never referenced by name in any "use client" file',
  clientFilesReferencingServerSecretNames.length === 0,
  clientFilesReferencingServerSecretNames.join(", "),
) && ok;

// Sale-Ready Phase E, E2.6 (Paddle Provider Resolver Activation) — 5
// additional checks, appended rather than replacing anything above.
// Check 24 (above) already confirms Paddle is only ever activated
// through getPaddleProviderConfig(); these five cover the remaining
// resolver-specific properties E2.6's own instructions call out
// individually — direct-env-read discipline, no hand-assembled config,
// TEST_MODE ordering, the unconfigured fallback still existing, and no
// network call during resolution.

// 30. provider.ts never reads a BILLING_* env var directly (by
// process.env access or by literal name) — every one of the six real
// Paddle env vars must be read exactly once, inside
// getPaddleProviderConfig() (paddle-config.ts), never duplicated or
// re-read here. A stray `process.env.BILLING_API_KEY` in the resolver
// itself would be a second, unvalidated read path — exactly what this
// check exists to catch.
const registryReadsBillingEnvDirectly =
  /process\.env\.BILLING_/.test(providerRegistryCodeOnly) ||
  /\bBILLING_(PROVIDER|ENVIRONMENT|API_KEY|WEBHOOK_SECRET|STARTER_PRICE_ID|PRO_PRICE_ID)\b/.test(providerRegistryCodeOnly);
ok = report(
  "provider.ts never reads a BILLING_* env var directly — only through getPaddleProviderConfig()",
  providerRegistrySource !== "" && !registryReadsBillingEnvDirectly,
  providerRegistrySource === "" ? "provider registry file not found" : "a BILLING_* env var or literal name was found directly in provider.ts",
) && ok;

// 31. provider.ts never assembles its own PaddleProviderConfig-shaped
// object — no `apiKey:`, `webhookSecret:`, or `priceIdByPlanKey:` field
// name anywhere in the file. The only legitimate config object is the
// one getPaddleProviderConfig() itself constructs and returns; a
// hand-assembled one in the resolver would be exactly the kind of
// partial/fallback construction E2.6 is required not to introduce.
const registryAssemblesOwnConfig = /\b(apiKey|webhookSecret|priceIdByPlanKey)\s*:/.test(providerRegistrySource);
ok = report(
  "provider.ts never hand-assembles its own Paddle config object (apiKey:/webhookSecret:/priceIdByPlanKey: field names)",
  providerRegistrySource !== "" && !registryAssemblesOwnConfig,
  providerRegistrySource === "" ? "provider registry file not found" : "found a config-shaped field name directly in provider.ts",
) && ok;

// 32. The TEST_MODE branch appears strictly before the Paddle-activation
// branch in source order — TEST_MODE must take priority over a real
// Paddle config even when both are present, so a local/test environment
// can never accidentally resolve to a real Paddle adapter.
//
// Two false-negative traps were found and fixed here during E2.6 PR
// review, both confirmed with a temporary, reverted PoC that introduced
// a real precedence bug (checking/activating Paddle before TEST_MODE) —
// the real unit test suite correctly failed on it, but this dedicated
// security check did not, until both traps below were fixed:
//   1. Matching against the raw source (not comment-stripped) only ever
//      verifies this file's own header doc comment's prose order ("TEST_MODE
//      on → ...", then "getPaddleProviderConfig()..."), never the real
//      code below it — fixed by matching against providerRegistryCodeOnly.
//   2. A bare `"TEST_MODE"` substring search matches this file's own
//      `import { TEST_MODE } from "@/lib/test-mode"` line, which always
//      sits at the top of the file regardless of the real function
//      body's branch order — so the check was structurally blind to any
//      reordering inside the function. Fixed by matching the actual
//      conditional (`if (TEST_MODE)` / `if(TEST_MODE)`) instead of the
//      bare identifier — the import line has no `if (...)` around it, so
//      it can never satisfy this pattern.
const testModeIndex = providerRegistryCodeOnly.search(/if\s*\(\s*TEST_MODE\s*\)/);
const paddleConfigIndex = providerRegistryCodeOnly.indexOf("getPaddleProviderConfig(");
ok = report(
  "the TEST_MODE branch appears before the Paddle-activation branch in provider.ts, so TEST_MODE always takes priority",
  testModeIndex !== -1 && paddleConfigIndex !== -1 && testModeIndex < paddleConfigIndex,
  `if (TEST_MODE) index: ${testModeIndex}, getPaddleProviderConfig( index: ${paddleConfigIndex}`,
) && ok;

// 33. The fail-closed unconfigured fallback is still present and still
// imported — a regression here (e.g. an accidental early return, or the
// import being dropped while refactoring) would mean an invalid/partial
// Paddle config falls through to `undefined` instead of a safe,
// controlled adapter.
const registryHasUnconfiguredFallback =
  /import\s*\{\s*createUnconfiguredBillingProvider\s*\}\s*from\s*"\.\/unconfigured-provider"/.test(providerRegistrySource) &&
  /createUnconfiguredBillingProvider\(\)/.test(providerRegistrySource);
ok = report(
  "the fail-closed unconfigured provider fallback is still imported and still referenced in provider.ts",
  providerRegistrySource !== "" && registryHasUnconfiguredFallback,
  providerRegistrySource === "" ? "provider registry file not found" : "createUnconfiguredBillingProvider is no longer imported/referenced",
) && ok;

// 34. getBillingProviderAdapter() itself makes no network call —
// provider.ts's own exported resolver function must stay fully
// synchronous (no `async`, no `await`, no `fetch(` anywhere in the
// file). Every actual Paddle API request happens lazily, later, inside a
// specific adapter method (createCheckoutSession/
// createCustomerPortalSession) — never merely by resolving which
// adapter to use.
const registryIsAsyncOrNetworked =
  /\basync\s+function\s+getBillingProviderAdapter\b/.test(providerRegistryCodeOnly) ||
  /\bawait\b/.test(providerRegistryCodeOnly) ||
  /\bfetch\(/.test(providerRegistryCodeOnly);
ok = report(
  "getBillingProviderAdapter() stays fully synchronous — no async/await/fetch anywhere in provider.ts",
  providerRegistrySource !== "" && !registryIsAsyncOrNetworked,
  providerRegistrySource === "" ? "provider registry file not found" : "found async/await/fetch in provider.ts",
) && ok;

process.exit(ok ? 0 : 1);
