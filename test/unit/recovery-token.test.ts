import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// src/lib/test-mode.ts's TEST_MODE is a module-level const computed once,
// from process.env.TEST_MODE, at first evaluation — so it must be set
// before recovery-token.ts (which imports test-mode.ts) is ever imported.
// A dynamic import after setting the env var guarantees that ordering,
// the same technique test/integration/cron/routes.test.ts already uses
// for its own env-dependent module. This exercises recovery-token.ts's
// real TEST_MODE branch directly — not a mock of it — since that branch
// (an in-memory Map) has no real Supabase/network dependency to fake.
vi.mock("server-only", () => ({}));

const ORIGINAL_TEST_MODE = process.env.TEST_MODE;
process.env.TEST_MODE = "1";

const { generateRecoveryToken, verifyRecoveryToken } = await import("@/lib/auth/recovery-token");

afterAll(() => {
  if (ORIGINAL_TEST_MODE === undefined) {
    delete process.env.TEST_MODE;
  } else {
    process.env.TEST_MODE = ORIGINAL_TEST_MODE;
  }
});

describe("recovery-token (TEST_MODE branch)", () => {
  it("generates a token and verifying it resolves the same email", async () => {
    const generated = await generateRecoveryToken("owner@example.com");
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;

    const verified = await verifyRecoveryToken(generated.tokenHash);
    expect(verified).toEqual({ ok: true, email: "owner@example.com" });
  });

  it("is deterministic per email (TEST_MODE only — real Supabase tokens are opaque/random) so an E2E test can independently compute it with no real mailbox to read", async () => {
    const first = await generateRecoveryToken("determinism@example.com");
    const second = await generateRecoveryToken("determinism@example.com");
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.tokenHash).toBe(second.tokenHash);
    expect(first.tokenHash).toBe(Buffer.from("determinism@example.com", "utf8").toString("base64url"));
  });

  it("different emails produce different token hashes", async () => {
    const a = await generateRecoveryToken("a@example.com");
    const b = await generateRecoveryToken("b@example.com");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });

  it("rejects an unknown/malformed token hash", async () => {
    const verified = await verifyRecoveryToken("this-was-never-issued");
    expect(verified).toEqual({ ok: false });
  });

  it("is single-use: verifying the same token twice fails the second time", async () => {
    const generated = await generateRecoveryToken("member@example.com");
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;

    const first = await verifyRecoveryToken(generated.tokenHash);
    expect(first).toEqual({ ok: true, email: "member@example.com" });

    const second = await verifyRecoveryToken(generated.tokenHash);
    expect(second).toEqual({ ok: false });
  });

  describe("expiry", () => {
    beforeAll(() => {
      vi.useFakeTimers();
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    it("rejects a token verified more than 1 hour after it was generated", async () => {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const generated = await generateRecoveryToken("portal-user@example.com");
      expect(generated.ok).toBe(true);
      if (!generated.ok) return;

      vi.setSystemTime(new Date("2026-01-01T01:00:00.001Z")); // 1 hour + 1ms later
      const verified = await verifyRecoveryToken(generated.tokenHash);
      expect(verified).toEqual({ ok: false });
    });

    it("accepts a token verified just under 1 hour after it was generated", async () => {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const generated = await generateRecoveryToken("portal-user-2@example.com");
      expect(generated.ok).toBe(true);
      if (!generated.ok) return;

      vi.setSystemTime(new Date("2026-01-01T00:59:59.000Z"));
      const verified = await verifyRecoveryToken(generated.tokenHash);
      expect(verified).toEqual({ ok: true, email: "portal-user-2@example.com" });
    });
  });
});
