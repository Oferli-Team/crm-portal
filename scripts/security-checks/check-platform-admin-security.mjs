import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { grep, report } from "./lib.mjs";

/** Recursively lists .ts/.tsx files under dir — LIB_DIR is flat today but this stays correct once it grows subdirectories (e.g. queries/). */
function listTsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      files.push(full);
    }
  }
  return files;
}

/** Strips /** block comments before matching, so a doc comment explaining a rule in prose (e.g. "never calls getCurrentMembership()") can never trip the check meant to catch a REAL call. */
function stripBlockComments(content) {
  return content.replace(/\/\*\*[\s\S]*?\*\//g, "");
}

// Sale-Ready Phase C. Platform Admin's entire purpose is to read across
// every organization — exactly what getCurrentUserOrganization()/
// getCurrentMembership() and the (dashboard)/portal route groups exist to
// prevent everywhere else in this app. That means the isolation boundary
// here has to be enforced structurally, not just by a role check that
// could accidentally be reused somewhere it shouldn't — same discipline
// as check-search-security.mjs/check-billing-security.mjs for their own
// feature boundaries.

let ok = true;

const LIB_DIR = "src/lib/platform-admin";
const APP_DIR = "src/app/(platform-admin)";
const LAYOUT_FILE = "src/app/(platform-admin)/layout.tsx";

// 1. Nothing under (dashboard) or portal ever imports the Platform Admin
// module — the whole point of a cross-tenant tool is that no tenant-
// scoped request path can ever reach it.
const dashboardImport = grep('from "@/lib/platform-admin', "src/app/(dashboard)");
const portalImport = grep('from "@/lib/platform-admin', "src/app/portal");
ok = report(
  "the Platform Admin module is never imported from (dashboard) or portal",
  dashboardImport === "" && portalImport === "",
  dashboardImport + portalImport,
) && ok;

// 2. The (platform-admin) layout — the single point every page in the
// group renders through — actually calls requirePlatformAdmin(). Guarded
// once here, not repeated per-page, the same "guard lives in the layout"
// pattern (dashboard)/layout.tsx already uses for its own portal-identity
// check.
const layoutContent = readFileSync(LAYOUT_FILE, "utf8");
const importsGuard = /import\s*\{[^}]*\brequirePlatformAdmin\b[^}]*\}\s*from\s*"@\/lib\/platform-admin\/authorization"/.test(
  layoutContent,
);
const callsGuard = layoutContent.includes("requirePlatformAdmin(");
ok = report(
  "the (platform-admin) layout imports and calls requirePlatformAdmin()",
  importsGuard && callsGuard,
  "",
) && ok;

// 3. Platform Admin queries never scope to one organization — a real call
// to getCurrentUserOrganization()/getCurrentMembership() here would mean
// this module has quietly started depending on "active organization,"
// exactly the single-tenant assumption it must never make. Block comments
// stripped first so a doc comment explaining this very rule in prose (as
// authorization.ts's own does) can never trip the check meant to catch a
// REAL call.
const libFiles = listTsFiles(LIB_DIR);
const forbiddenIdentityPattern = /getCurrentUserOrganization\(|getCurrentMembership\(/;
const filesCallingForbiddenIdentity = libFiles.filter((f) => forbiddenIdentityPattern.test(stripBlockComments(readFileSync(f, "utf8"))));
ok = report(
  "src/lib/platform-admin never calls getCurrentUserOrganization/getCurrentMembership",
  filesCallingForbiddenIdentity.length === 0,
  filesCallingForbiddenIdentity.join(", "),
) && ok;

// 4. No raw query anywhere in the module. Phase C's whole query surface is
// plain Prisma — if this ever needs to change (e.g. a future Platform
// Health PR reading Prisma's own _prisma_migrations table), that's a
// deliberate, reviewed exception, not something that should silently pass
// this check.
const rawQueryPattern = /\$queryRaw|\$executeRaw/;
const filesWithRawQueries = libFiles.filter((f) => rawQueryPattern.test(stripBlockComments(readFileSync(f, "utf8"))));
ok = report("no raw query anywhere in src/lib/platform-admin", filesWithRawQueries.length === 0, filesWithRawQueries.join(", ")) && ok;

// 5. No "use server" directive anywhere under src/lib/platform-admin or
// src/app/(platform-admin) — Sale-Ready Phase C, PR3's own explicit
// "read-only, no mutations, no server actions" requirement, made
// structural rather than a code-review hope. A real directive is always
// the first non-empty line of a file, quoted with either quote style —
// checking that (not just "the string appears anywhere") means a file
// that merely *mentions* "use server" in a comment explaining why it
// deliberately has none can never trip this.
const appFiles = listTsFiles(APP_DIR);
const useServerPattern = /^["']use server["'];?\s*$/;
function firstNonEmptyLine(content) {
  return content.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}
const filesWithUseServer = [...libFiles, ...appFiles].filter((f) => useServerPattern.test(firstNonEmptyLine(readFileSync(f, "utf8"))));
ok = report(
  'no "use server" directive anywhere in src/lib/platform-admin or src/app/(platform-admin)',
  filesWithUseServer.length === 0,
  filesWithUseServer.join(", "),
) && ok;

// 6. No actions.ts file anywhere under src/app/(platform-admin) — the
// same "the absence of a mutation surface is itself auditable" property
// PR1 established (no actions.ts existed at all in the Foundation),
// extended to cover every route this and future Phase C PRs add.
const actionsFiles = appFiles.filter((f) => f.endsWith("/actions.ts") || f.endsWith("\\actions.ts"));
ok = report("no actions.ts file anywhere under src/app/(platform-admin)", actionsFiles.length === 0, actionsFiles.join(", ")) && ok;

process.exit(ok ? 0 : 1);
