import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { grep, report } from "./lib.mjs";

// Stage 8's cron infrastructure (CRON_SECRET auth, background notification
// jobs) has its own trust boundary — every check below targets a specific
// way that boundary could quietly weaken, the same discipline as
// check-no-test-mode.mjs for the E2E identity bypass.

let ok = true;

// 1. CRON_SECRET is never exposed via a NEXT_PUBLIC_ variable anywhere.
// (check-no-public-secrets.mjs's generic NEXT_PUBLIC_*SECRET pattern would
// already catch this — this is a dedicated, name-specific check so a
// future rename of that generic pattern can't silently stop covering it.)
const publicCronSecret = grep("NEXT_PUBLIC_[A-Z_]*CRON_SECRET", "src/");
ok = report("CRON_SECRET is never referenced with a NEXT_PUBLIC_ prefix", publicCronSecret === "", publicCronSecret) && ok;

// 2. Every /api/cron/* Route Handler calls the one shared auth helper —
// never a local reimplementation of the bearer-token check.
const cronApiDir = "src/app/api/cron";
if (existsSync(cronApiDir)) {
  const routeFiles = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.ts") routeFiles.push(full);
    }
  };
  walk(cronApiDir);

  ok = report(`at least one cron route exists under ${cronApiDir}`, routeFiles.length > 0, "") && ok;

  for (const file of routeFiles) {
    const content = readFileSync(file, "utf8");
    const importsHelper = content.includes('from "@/lib/cron/auth"');
    const callsHelper = /requireCronAuth\(/.test(content);
    ok = report(`${file} imports and calls requireCronAuth`, importsHelper && callsHelper, "") && ok;
  }

  // 3. No cron route (or the auth helper itself) ever reads the secret
  // from a query string/searchParams — Authorization header only.
  const queryStringReads = grep("searchParams", cronApiDir);
  ok = report("no cron route reads anything from a query string", queryStringReads === "", queryStringReads) && ok;
} else {
  ok = report(`${cronApiDir} exists`, false, "Expected the cron Route Handlers directory to exist.") && ok;
}

const queryStringInHelper = grep("searchParams", "src/lib/cron/auth.ts");
ok = report("requireCronAuth never reads a query string", queryStringInHelper === "", queryStringInHelper) && ok;

// 4. No TEST_MODE bypass in the cron auth helper — deliberately, unlike
// the identity/Storage test-mode swaps elsewhere in this app (see
// src/lib/cron/auth.ts's own docstring for why, which mentions the phrase
// "TEST_MODE" in prose — this checks for an actual runtime reference, not
// that comment). Tests authenticate through this exact same check with a
// real (test-only) CRON_SECRET value.
const testModeInHelper = grep('process\\.env\\.TEST_MODE|from "@/lib/test-mode"', "src/lib/cron/auth.ts");
ok = report("requireCronAuth has no TEST_MODE-gated bypass", testModeInHelper === "", testModeInHelper) && ok;

// 5. The background job modules and the notification email template are
// never reachable from a Client Component — they touch Prisma/raw
// notification metadata and must stay server-only.
const clientComponentFiles = grep('"use client"', "src/", "--include=*.tsx -l")
  .trim()
  .split("\n")
  .filter(Boolean);
const sensitiveImportTargets = [
  "@/lib/notifications/jobs/retry-notification-deliveries",
  "@/lib/notifications/jobs/cleanup-notifications",
  "@/lib/notifications/jobs/digest-candidates",
  "@/lib/notifications/email/format-notification-email",
  "@/lib/cron/auth",
  "@/lib/invoices/pdf/reconcile-archive-objects",
];
const leaks = [];
for (const file of clientComponentFiles) {
  const content = readFileSync(file, "utf8");
  for (const target of sensitiveImportTargets) {
    if (content.includes(`from "${target}"`)) {
      leaks.push(`${file} imports ${target}`);
    }
  }
}
ok = report(
  "no Client Component imports a notification job module, the email template, or the cron auth helper",
  leaks.length === 0,
  leaks.join("\n"),
) && ok;

process.exit(ok ? 0 : 1);
