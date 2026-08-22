import { consumeRateLimitBucket } from "./store";
import type { RateLimitConfig } from "./types";

export * from "./limits";
export { getRequestIp, getIpFromRequest } from "./ip";
export type { RateLimitConfig, RateLimitResult } from "./types";

// Never expose which limiter tripped, the count, or the reset time to the
// caller — every limited response returns this exact generic message.
export const RATE_LIMIT_MESSAGE = "Too many requests. Please try again later.";

export type RateLimitCheck = { limited: true; message: string } | { limited: false };

/**
 * Single entry point every Server Action/Route Handler calls — never the
 * store directly. `identifier` is whatever key value applies for this
 * config's scope (an IP, a user id, an email, an invitation id); config.scope
 * namespaces it so the same raw identifier never collides across unrelated
 * limiters.
 */
export function checkRateLimit(config: RateLimitConfig, identifier: string): RateLimitCheck {
  const result = consumeRateLimitBucket(`${config.scope}:${identifier}`, config.limit, config.windowMs);
  if (!result.allowed) {
    return { limited: true, message: RATE_LIMIT_MESSAGE };
  }
  return { limited: false };
}
