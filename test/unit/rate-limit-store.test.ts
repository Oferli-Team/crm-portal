import { describe, expect, it, vi } from "vitest";
import { consumeRateLimitBucket } from "@/lib/rate-limit/store";
import { checkRateLimit } from "@/lib/rate-limit";
import type { RateLimitConfig } from "@/lib/rate-limit/types";

// `buckets` in store.ts is a module-level singleton (by design — one shared
// in-memory store per process, matching production). Every test below uses
// a randomized, per-test key so tests never collide with each other
// regardless of execution order or whether Vitest shares the module
// registry across files in the same worker.
function uniqueKey(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2)}`;
}

describe("consumeRateLimitBucket", () => {
  it("allows the first N requests and blocks the N+1th", () => {
    const key = uniqueKey("allow-block");
    for (let i = 0; i < 3; i++) {
      expect(consumeRateLimitBucket(key, 3, 60_000).allowed).toBe(true);
    }
    const blocked = consumeRateLimitBucket(key, 3, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it("decreases remaining by one on each allowed call", () => {
    const key = uniqueKey("remaining");
    expect(consumeRateLimitBucket(key, 5, 60_000).remaining).toBe(4);
    expect(consumeRateLimitBucket(key, 5, 60_000).remaining).toBe(3);
    expect(consumeRateLimitBucket(key, 5, 60_000).remaining).toBe(2);
  });

  it("keeps a stable reset time across calls within the same window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const key = uniqueKey("reset-stable");
      const first = consumeRateLimitBucket(key, 5, 60_000);
      vi.advanceTimersByTime(30_000);
      const second = consumeRateLimitBucket(key, 5, 60_000);
      expect(second.reset).toBe(first.reset);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets once the window has fully elapsed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const key = uniqueKey("window-reset");
      consumeRateLimitBucket(key, 1, 1000);
      expect(consumeRateLimitBucket(key, 1, 1000).allowed).toBe(false);

      vi.advanceTimersByTime(1001);
      const afterReset = consumeRateLimitBucket(key, 1, 1000);
      expect(afterReset.allowed).toBe(true);
      expect(afterReset.remaining).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates different keys from one another", () => {
    const keyA = uniqueKey("iso-a");
    const keyB = uniqueKey("iso-b");
    consumeRateLimitBucket(keyA, 1, 60_000);
    expect(consumeRateLimitBucket(keyA, 1, 60_000).allowed).toBe(false);
    expect(consumeRateLimitBucket(keyB, 1, 60_000).allowed).toBe(true);
  });
});

describe("checkRateLimit — scope isolation", () => {
  it("isolates different scopes even for the identical identifier", () => {
    const identifier = uniqueKey("shared-identifier");
    const configA: RateLimitConfig = { scope: uniqueKey("scope-a"), limit: 1, windowMs: 60_000 };
    const configB: RateLimitConfig = { scope: uniqueKey("scope-b"), limit: 1, windowMs: 60_000 };

    expect(checkRateLimit(configA, identifier).limited).toBe(false);
    expect(checkRateLimit(configA, identifier).limited).toBe(true);
    expect(checkRateLimit(configB, identifier).limited).toBe(false);
  });

  it("scopes an empty/invalid identifier per-config, never as one shared global bucket", () => {
    const configA: RateLimitConfig = { scope: uniqueKey("scope-empty-a"), limit: 1, windowMs: 60_000 };
    const configB: RateLimitConfig = { scope: uniqueKey("scope-empty-b"), limit: 1, windowMs: 60_000 };

    expect(checkRateLimit(configA, "").limited).toBe(false);
    expect(checkRateLimit(configA, "").limited).toBe(true);
    // A different scope's own empty-identifier bucket must be untouched —
    // an empty identifier is namespaced by config.scope just like any
    // other identifier, never a single cross-scope bucket.
    expect(checkRateLimit(configB, "").limited).toBe(false);
  });

  it("never exposes counters, reset time, or the scope name to the caller", () => {
    const config: RateLimitConfig = { scope: uniqueKey("no-leak"), limit: 1, windowMs: 60_000 };
    checkRateLimit(config, "id");
    const blocked = checkRateLimit(config, "id");
    expect(blocked).toEqual({ limited: true, message: "Too many requests. Please try again later." });
    expect(Object.keys(blocked)).toEqual(["limited", "message"]);
  });
});

describe("sweep of expired entries", () => {
  it("clears a truly expired bucket without disturbing a still-active one", async () => {
    // Fresh module instance so the sweep-every-500-calls counter starts at
    // exactly 0, independent of whatever other tests in this file already
    // called consumeRateLimitBucket.
    vi.resetModules();
    const freshStore = await import("@/lib/rate-limit/store");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const expiredKey = uniqueKey("sweep-expired");
      freshStore.consumeRateLimitBucket(expiredKey, 1, 1000);
      vi.advanceTimersByTime(2000); // now expired

      const activeKey = uniqueKey("sweep-active");
      const beforeSweep = freshStore.consumeRateLimitBucket(activeKey, 5, 60_000);
      expect(beforeSweep.remaining).toBe(4);

      // Drive the sweep (every 500 calls) with filler calls against
      // already-expired keys — never touching activeKey.
      for (let i = 0; i < 500; i++) {
        freshStore.consumeRateLimitBucket(`${expiredKey}-filler-${i}`, 1, 1);
      }

      // The active bucket's own count must be exactly what it was before
      // the sweep ran — sweeping only removes expired entries, it never
      // resets or otherwise touches one that's still within its window.
      const afterSweep = freshStore.consumeRateLimitBucket(activeKey, 5, 60_000);
      expect(afterSweep.remaining).toBe(3);

      // The expired key gets a brand-new window on its next call — proof
      // it was actually swept (or, equivalently, correctly treated as
      // expired), not left stuck.
      const expiredKeyAgain = freshStore.consumeRateLimitBucket(expiredKey, 1, 1000);
      expect(expiredKeyAgain.allowed).toBe(true);
      expect(expiredKeyAgain.remaining).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
