/**
 * One identifier per test run, threaded into every fixture's
 * name/email/slug/storage path so cleanup can scope to exactly what a run
 * created — see test/fixtures/cleanup.ts. Stable for the lifetime of one
 * process (computed once, reused on every call within that run).
 */
let cachedRunId: string | undefined;

export function getRunId(): string {
  if (cachedRunId) return cachedRunId;

  cachedRunId =
    process.env.GITHUB_RUN_ID ??
    process.env.TEST_RUN_ID ??
    Math.random().toString(36).slice(2, 10);

  return cachedRunId;
}

/** e.g. "owner-a" -> "owner-a-x7f3k2p1@test.local" for a given run. */
export function testEmail(localPart: string, domain: string, runId = getRunId()): string {
  return `${localPart}-${runId}@${domain}`;
}

/** e.g. "org-a" -> "test-org-a-x7f3k2p1", for org slugs / Client names / etc. */
export function testSlug(label: string, runId = getRunId()): string {
  return `test-${label}-${runId}`;
}

/** e.g. "attachments" -> "test-runs/x7f3k2p1/attachments/..." Storage prefix. */
export function testStoragePrefix(runId = getRunId()): string {
  return `test-runs/${runId}`;
}
