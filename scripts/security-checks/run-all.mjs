import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const checks = readdirSync(dir)
  .filter((f) => f.startsWith("check-") && f.endsWith(".mjs"))
  .sort();

let failures = 0;
for (const check of checks) {
  try {
    execFileSync(process.execPath, [join(dir, check)], { stdio: "inherit" });
  } catch {
    failures += 1;
  }
}

console.log(`\n${checks.length - failures}/${checks.length} security checks passed.`);
process.exit(failures === 0 ? 0 : 1);
