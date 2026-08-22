import { describe, expect, it } from "vitest";
import { getRunId, testEmail, testSlug } from "../support/run-id";

// Proves Vitest itself runs, and that the tsconfig-paths plugin + the
// shared test/support helpers resolve correctly — nothing else yet.
describe("test infrastructure smoke check", () => {
  it("runs a basic assertion", () => {
    expect(1 + 1).toBe(2);
  });

  it("resolves test/support/run-id helpers", () => {
    const runId = getRunId();
    expect(runId.length).toBeGreaterThan(0);
    expect(testEmail("owner-a", "test.local", runId)).toBe(`owner-a-${runId}@test.local`);
    expect(testSlug("org-a", runId)).toBe(`test-org-a-${runId}`);
  });
});
