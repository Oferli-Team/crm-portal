import { grep, readLines, report } from "./lib.mjs";

// A plain grep for "cookieOptions:" can't tell whether it belongs to the
// SAME createServerClient(...) call it's near, so this walks a few lines
// forward from each call site instead of just checking file-wide presence.
const PROXIMITY_LINES = 10;

function findCallSites() {
  // The trailing "(" must be escaped — lib.mjs's grep() always runs with
  // -E (extended regex), under which an unescaped "(" starts a capture
  // group instead of matching a literal parenthesis.
  const output = grep("createServerClient\\(", "src/");
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [file, lineNo, ...rest] = line.split(":");
      return { file, lineNo: Number(lineNo), content: rest.join(":") };
    })
    // Skip doc-comment mentions (e.g. "every createServerClient() call
    // site") — only real invocations, which are actual code, not comments.
    .filter(({ content }) => {
      const trimmed = content.trim();
      return !trimmed.startsWith("*") && !trimmed.startsWith("//");
    });
}

const callSites = findCallSites();
const missing = [];

for (const { file, lineNo } of callSites) {
  const lines = readLines(file);
  const window = lines.slice(lineNo - 1, lineNo - 1 + PROXIMITY_LINES).join("\n");
  if (!window.includes("cookieOptions:")) {
    missing.push(`${file}:${lineNo}`);
  }
}

const passed = report(
  `every createServerClient( call site passes cookieOptions: (${callSites.length} call site(s) checked)`,
  missing.length === 0,
  missing.join("\n"),
);
process.exit(passed ? 0 : 1);
