import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// src/lib/cron/auth.ts imports the real "server-only" marker package,
// which throws unless resolved under Next's own "react-server" condition
// (see node_modules/server-only/index.js) — a guard this test process
// doesn't provide. Neutralizing the marker here doesn't touch
// requireCronAuth's own logic at all; it only silences an import-time
// guard that's meaningless outside Next's build, the same way every other
// server-only-importing module in this app is only ever unit-exercised
// through a whole-module vi.mock() swap (see test/integration/setup-
// mocks.ts's @/lib/storage/attachments-storage mock) rather than by
// disabling the guard globally in vitest.config.ts.
vi.mock("server-only", () => ({}));

const { requireCronAuth } = await import("@/lib/cron/auth");

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

function requestWithAuth(header: string | null): Request {
  const headers = new Headers();
  if (header !== null) headers.set("authorization", header);
  return new Request("http://localhost/api/cron/notification-delivery", { headers });
}

afterEach(() => {
  if (ORIGINAL_CRON_SECRET === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  }
});

describe("requireCronAuth — correct bearer", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "test-secret-value";
  });

  it("allows a request with the exact matching bearer token (returns null — no rejection response)", () => {
    const result = requireCronAuth(requestWithAuth("Bearer test-secret-value"));
    expect(result).toBeNull();
  });
});

describe("requireCronAuth — rejections", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "test-secret-value";
  });

  it("rejects a missing authorization header with a generic 401", async () => {
    const result = requireCronAuth(requestWithAuth(null));
    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);
    expect(await result?.json()).toEqual({ error: "Unauthorized" });
  });

  it("rejects a malformed header (no 'Bearer ' prefix)", async () => {
    const result = requireCronAuth(requestWithAuth("test-secret-value"));
    expect(result?.status).toBe(401);
  });

  it("rejects a malformed header (wrong scheme)", async () => {
    const result = requireCronAuth(requestWithAuth("Basic test-secret-value"));
    expect(result?.status).toBe(401);
  });

  it("rejects the wrong secret", async () => {
    const result = requireCronAuth(requestWithAuth("Bearer wrong-value"));
    expect(result?.status).toBe(401);
  });

  it("rejects a bearer value that is merely a prefix/suffix of the real secret", async () => {
    const result = requireCronAuth(requestWithAuth("Bearer test-secret-value-extra"));
    expect(result?.status).toBe(401);
  });

  it("rejects an empty bearer value", async () => {
    const result = requireCronAuth(requestWithAuth("Bearer "));
    expect(result?.status).toBe(401);
  });
});

describe("requireCronAuth — CRON_SECRET unset (fails closed)", () => {
  beforeEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("rejects every request, even one presenting a plausible-looking bearer value, when CRON_SECRET is unset", async () => {
    const result = requireCronAuth(requestWithAuth("Bearer anything"));
    expect(result?.status).toBe(401);
  });

  it("rejects a request with no authorization header at all when CRON_SECRET is unset", async () => {
    const result = requireCronAuth(requestWithAuth(null));
    expect(result?.status).toBe(401);
  });

  it("the rejection reason is identical (generic) whether the secret is unset or just wrong — a caller can't distinguish the two", async () => {
    delete process.env.CRON_SECRET;
    const unsetResult = await requireCronAuth(requestWithAuth("Bearer anything"))?.json();

    process.env.CRON_SECRET = "test-secret-value";
    const wrongResult = await requireCronAuth(requestWithAuth("Bearer wrong"))?.json();

    expect(unsetResult).toEqual(wrongResult);
  });
});
