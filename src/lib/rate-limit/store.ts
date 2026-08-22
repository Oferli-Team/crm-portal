import type { RateLimitResult } from "./types";

type Bucket = { count: number; resetAt: number };

// In-memory, per-instance — this app has no Prisma-modeled counters table
// and no external store provisioned, and a serverless cold start simply
// resets the window rather than granting unbounded extra attempts, which is
// an acceptable tradeoff for this layer of defense (see Stage 4 decision).
const buckets = new Map<string, Bucket>();

let callsSinceSweep = 0;
const SWEEP_INTERVAL = 500;

function sweepExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

/**
 * Fixed-window counter keyed by an already-namespaced string. Every caller
 * goes through checkRateLimit() in ./index.ts, never this function directly.
 */
export function consumeRateLimitBucket(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();

  callsSinceSweep += 1;
  if (callsSinceSweep >= SWEEP_INTERVAL) {
    callsSinceSweep = 0;
    sweepExpired(now);
  }

  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: limit - 1, reset: resetAt };
  }

  if (existing.count >= limit) {
    return { allowed: false, remaining: 0, reset: existing.resetAt };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: Math.max(0, limit - existing.count),
    reset: existing.resetAt,
  };
}
