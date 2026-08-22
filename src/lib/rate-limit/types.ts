export type RateLimitConfig = {
  /** Namespaces this limiter's keys so the same raw identifier (an IP,
   * a user id, ...) never collides across unrelated limiters. */
  scope: string;
  limit: number;
  windowMs: number;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  /** Epoch ms when this key's window resets. */
  reset: number;
};
