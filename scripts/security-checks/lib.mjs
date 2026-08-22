import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * Greps a directory for a fixed-string or regex pattern. Returns matching
 * lines (possibly empty) — grep's own "no matches" exit code (1) is treated
 * as a normal, successful "found nothing" result, not an error.
 *
 * Uses execFileSync (argv array, no shell) rather than a shell-interpolated
 * string — a pattern containing a literal `"` (e.g. matching an import
 * like `from "@/lib/x"`) would otherwise break the naive
 * `"${pattern}"`-wrapped shell command's own quoting, silently returning
 * zero matches instead of an error. execFileSync passes each argument to
 * grep directly, so the pattern's actual characters never need escaping.
 */
export function grep(pattern, dir, extraFlags = "") {
  const flags = extraFlags ? extraFlags.split(" ").filter(Boolean) : [];
  try {
    return execFileSync("grep", ["-rnE", ...flags, pattern, dir], { encoding: "utf8" });
  } catch (err) {
    if (err.status === 1) return "";
    throw err;
  }
}

export function readLines(path) {
  return readFileSync(path, "utf8").split("\n");
}

/** Prints a pass/fail line and returns whether the check passed. */
export function report(name, passed, detail) {
  if (passed) {
    console.log(`OK   ${name}`);
    return true;
  }
  console.error(`FAIL ${name}`);
  if (detail) console.error(detail);
  return false;
}
