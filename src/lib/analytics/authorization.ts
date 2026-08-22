import type { Role } from "@/generated/prisma/enums";

/**
 * Analytics Stage 1 (docs/analytics-architecture.md §7). Analytics
 * surfaces aggregate business data (revenue-adjacent counts, growth
 * trends) that this stage treats as OWNER/ADMIN-only, matching the task
 * spec's own explicit security requirement — MEMBER is a hard block for
 * now ("MEMBER access should remain configurable later" — Stage 1 does
 * not implement that configurability, just leaves the single call site
 * below as the one place a future stage would change). Client Portal
 * identities never reach this at all: every call site lives under the
 * `(dashboard)` route group, whose layout already redirects any
 * Portal-only identity to `/portal` before this function is ever called
 * (mirrors src/app/(dashboard)/settings/billing/page.tsx's own doc
 * comment on that same guarantee).
 */
export class AnalyticsAccessError extends Error {
  constructor() {
    super("Analytics is only available to organization owners and admins.");
    this.name = "AnalyticsAccessError";
  }
}

export function canViewAnalytics(role: Role): boolean {
  return role === "OWNER" || role === "ADMIN";
}

/** Throws `AnalyticsAccessError` for MEMBER — every service-layer entry point calls this first, so no query below it ever runs for an unauthorized role. */
export function assertCanViewAnalytics(role: Role): void {
  if (!canViewAnalytics(role)) {
    throw new AnalyticsAccessError();
  }
}
