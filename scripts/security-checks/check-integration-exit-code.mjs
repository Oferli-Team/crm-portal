import { execFile } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Sale-Ready Phase E, E3.4. Not a static/grep check like every other file
 * in this directory — a real, end-to-end smoke test of the integration
 * test runner's own exit-code propagation, added after discovering that
 * `npm run test:integration` (and even a bare `vitest run --config
 * vitest.integration.config.mts`) reported failing tests but still exited
 * 0, which meant GitHub CI's "integration" check could never actually fail
 * from a real integration-test regression (see this stage's own report for
 * the full root cause: `@electric-sql/pglite`'s WASM Postgres engine calls
 * Emscripten's `quit_` shim on `.close()`, which does a bare
 * `process.exitCode = status` — clobbering whatever exit code Vitest had
 * already set, regardless of test outcome). `test/support/local-
 * postgres.ts`'s `stopTestDatabase()` now saves/restores `process.exitCode`
 * around that shutdown sequence specifically to prevent this — this check
 * exists so a future change to that fix, to `@electric-sql/pglite`'s own
 * behavior, or to `vitest.integration.config.mts` can never silently regress
 * back to a CI setup that accepts arbitrary integration failures as green.
 *
 * Writes one throwaway, deliberately-failing spec file inside
 * `test/integration/` (Vitest's own `include` glob requires it to live
 * there to be picked up at all), runs the real integration config against
 * only that one file, and asserts the child process exits non-zero. Always
 * deletes the throwaway file in a `finally`, so a crash mid-check never
 * leaves it behind for the real suite to pick up.
 *
 * A non-zero exit code alone isn't sufficient proof: a spawn failure, a
 * broken PGlite/migration startup, or a TypeScript error in the spec
 * itself would *also* exit non-zero, without ever actually exercising the
 * exit-code-propagation behavior this check exists to guard (confirmed by
 * temporarily hiding `node_modules/.bin/vitest` during E3.4's own review —
 * the exit-code check alone reported "OK" even though vitest never ran at
 * all). So this also asserts the child's own combined output contains the
 * exact marker string this spec's `it(...)` name carries — proof the
 * deliberately-failing assertion actually ran and was reported as a
 * failure, not that something unrelated crashed first.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpSpecRelative = "test/integration/.tmp-exit-code-smoke.test.ts";
const tmpSpecAbsolute = join(repoRoot, tmpSpecRelative);
const FAILING_TEST_NAME = "deliberately fails so the exit-code smoke check can observe a non-zero exit";

const TMP_SPEC_CONTENTS = `import { expect, it } from "vitest";

// Not a real regression — deliberately failing, on purpose, only ever
// written by scripts/security-checks/check-integration-exit-code.mjs and
// deleted immediately after. See that script's own header comment.
it("${FAILING_TEST_NAME}", () => {
  expect(1).toBe(2);
});
`;

function runIntegrationConfigAgainst(specRelativePath) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["node_modules/.bin/vitest", "run", "--config", "vitest.integration.config.mts", specRelativePath],
      { cwd: repoRoot, env: process.env },
      (error, stdout, stderr) => {
        // execFile's callback receives a non-null `error` whenever the
        // child exited non-zero — `error.code` IS that exit code. No error
        // at all means the child exited 0.
        resolve({
          exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          output: `${stdout ?? ""}${stderr ?? ""}`,
        });
      },
    );
  });
}

async function main() {
  let ok = false;
  await writeFile(tmpSpecAbsolute, TMP_SPEC_CONTENTS, "utf-8");
  try {
    const { exitCode, output } = await runIntegrationConfigAgainst(tmpSpecRelative);
    const ranAndFailedAsExpected = output.includes(FAILING_TEST_NAME);
    if (exitCode !== 0 && ranAndFailedAsExpected) {
      console.log(`OK   a deliberately failing integration spec makes \`vitest run --config vitest.integration.config.mts\` exit non-zero (got ${exitCode})`);
      ok = true;
    } else if (exitCode === 0 && ranAndFailedAsExpected) {
      console.error("FAIL the deliberately failing integration spec ran and was reported as failed, but the runner still exited 0 — the integration runner would silently accept a real regression as green");
    } else {
      console.error("FAIL the deliberately failing integration spec never actually ran (spawn/startup failure before Vitest could report a result) — this check is inconclusive, not a pass; investigate the runner invocation itself");
      console.error(output);
    }
  } finally {
    await unlink(tmpSpecAbsolute).catch(() => {});
  }
  process.exit(ok ? 0 : 1);
}

await main();
