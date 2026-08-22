import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { grep, report } from "./lib.mjs";

// Global Search Stage 2 (docs/search-architecture.md §6, and this stage's
// own explicit auth/route contract) has its own trust boundary — a JSON
// API that must never behave like a page. Every check below targets a
// specific way that boundary could quietly weaken, the same discipline as
// check-cron-security.mjs for the cron auth boundary.

let ok = true;

const ROUTE_FILE = "src/app/api/search/route.ts";
const SEARCH_LIB_DIR = "src/lib/search";

// 1. The route never calls getOrCreateUser()/getCurrentUserOrganization()/
// getCurrentMembership() — any of those can redirect() or auto-provision,
// exactly what an API route must never do (see getSearchRequestContext's
// own docstring for the full reasoning).
const routeContent = readFileSync(ROUTE_FILE, "utf8");
const forbiddenIdentityCalls = ["getOrCreateUser(", "getCurrentUserOrganization(", "getCurrentMembership("];
const foundForbiddenCalls = forbiddenIdentityCalls.filter((call) => routeContent.includes(call));
ok =
  report(
    "/api/search does not call getOrCreateUser/getCurrentUserOrganization/getCurrentMembership",
    foundForbiddenCalls.length === 0,
    foundForbiddenCalls.join(", "),
  ) && ok;

// 2. Neither the route nor getSearchRequestContext ever *imports*
// redirect() from next/navigation — an HTML 3xx response a fetch() caller
// can't meaningfully act on. Checking for a real import (not just the bare
// word "redirect(", which this file's own docstrings legitimately mention
// in prose when explaining what NOT to do) is what actually matters: you
// cannot call the function in this codebase without importing it first.
const requestContextContent = readFileSync(`${SEARCH_LIB_DIR}/request-context.ts`, "utf8");
const importsRedirect = (content) => /import\s*\{[^}]*\bredirect\b[^}]*\}\s*from\s*"next\/navigation"/.test(content);
ok = report("/api/search route never imports redirect() from next/navigation", !importsRedirect(routeContent), "") && ok;
ok = report(
  "getSearchRequestContext never imports redirect() from next/navigation",
  !importsRedirect(requestContextContent),
  "",
) && ok;

// 3. Every result URL is built only by the shared allowlist helper
// (result-links.ts) — no other file under src/lib/search constructs a
// `/clients/`, `/projects/`, `/tasks/`, or `/invoices/` path itself
// (which would be a second, unaudited place a URL could be built from
// unchecked input). Requires the segment to immediately follow a quote or
// backtick (the start of an actual string literal) so a docstring merely
// *mentioning* an existing file path like
// "src/app/(dashboard)/clients/query.ts" in prose is never a false match.
const routeSegmentPattern = '(`|")(/clients/|/projects/|/tasks/|/invoices/)';
const filesInSearchDir = readdirSync(SEARCH_LIB_DIR).filter((f) => f.endsWith(".ts") && f !== "result-links.ts");
const strayUrlBuilders = [];
for (const file of filesInSearchDir) {
  const content = readFileSync(join(SEARCH_LIB_DIR, file), "utf8");
  if (new RegExp(routeSegmentPattern).test(content)) {
    strayUrlBuilders.push(file);
  }
}
ok = report(
  "only result-links.ts builds a /clients|/projects|/tasks|/invoices path",
  strayUrlBuilders.length === 0,
  strayUrlBuilders.join(", "),
) && ok;

// 4. Nothing under src/lib/search or the route imports the Client Portal
// identity module — Search is staff-only by construction, and a portal
// import here would be the first sign of that boundary blurring.
const portalImport = grep('from "@/lib/current-portal-user"', SEARCH_LIB_DIR) + grep('from "@/lib/current-portal-user"', "src/app/api/search");
ok = report("no Client Portal import anywhere in the search backend", portalImport === "", portalImport) && ok;

// 5. No query-content logging — a console.log/console.error/console.warn
// call that could embed the raw search query (which may contain a
// client/comment's real content) anywhere in the search backend. An
// aggregate, query-free error log (e.g. the route's own generic 500
// catch, which logs nothing at all) remains allowed.
const consoleCalls = grep("console\\.(log|error|warn|info|debug)\\(", SEARCH_LIB_DIR) + grep("console\\.(log|error|warn|info|debug)\\(", "src/app/api/search");
ok = report("no console logging anywhere in the search backend", consoleCalls === "", consoleCalls) && ok;

process.exit(ok ? 0 : 1);
