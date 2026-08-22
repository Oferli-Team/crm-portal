import { formatFileSize } from "@/lib/format";

/**
 * Billing & Subscriptions Stage 3 (docs/billing-architecture.md's own
 * Stage 3 note). Pure, DOM/DB-free presentation logic for one usage row
 * (members/clients/projects/storage) — the Billing page's React
 * components never recompute this arithmetic themselves; they only ever
 * render what this module already decided, the same "components are thin
 * composers over a pure lib function" discipline this codebase already
 * applies everywhere else (src/lib/search-ui/*, src/lib/comments/*).
 */

export type UsageStatus = "NORMAL" | "APPROACHING" | "REACHED" | "EXCEEDED";

/** >=80% of a real (non-null, non-zero) limit — the one threshold this whole module is built around. Exported so a test (or a future design-doc change) has exactly one place to point at. */
export const APPROACHING_THRESHOLD_RATIO = 0.8;

export type UsageRowPresentation = {
  /** `null` when the limit itself is unlimited — never a fake 0-100 value in that case. */
  percentage: number | null;
  status: UsageStatus;
  unlimited: boolean;
};

/**
 * `limit === null` means unlimited: always NORMAL, `percentage: null` —
 * never a synthetic 100% bar for something that was never actually
 * capped (docs/billing-architecture.md's own "unlimited never draws an
 * artificial 100% progress" rule).
 *
 * `limit === 0` is a real, safely-handled degenerate case (never a
 * division by zero): `current === 0` reads as REACHED (nothing can be
 * created, but nothing is over either), `current > 0` reads as EXCEEDED.
 * `percentage` is reported as 100 in both — a zero-limit row is, by
 * definition, always "full."
 *
 * For a real positive limit, `percentage` is the true, unclamped ratio
 * (can exceed 100 for EXCEEDED) — callers that need a clamped value for a
 * progress bar's own visual width do that clamping themselves at render
 * time; this function's own `percentage` is the source of truth for the
 * *number*, not for how wide a `<div>` should be.
 */
export function computeUsageStatus(current: number, limit: number | null): UsageRowPresentation {
  if (limit === null) {
    return { percentage: null, status: "NORMAL", unlimited: true };
  }

  if (limit === 0) {
    return { percentage: 100, status: current > 0 ? "EXCEEDED" : "REACHED", unlimited: false };
  }

  const ratio = current / limit;
  const percentage = Math.round(ratio * 100);

  let status: UsageStatus;
  if (ratio > 1) {
    status = "EXCEEDED";
  } else if (ratio === 1) {
    status = "REACHED";
  } else if (ratio >= APPROACHING_THRESHOLD_RATIO) {
    status = "APPROACHING";
  } else {
    status = "NORMAL";
  }

  return { percentage, status, unlimited: false };
}

/** Plain integers ("3", "10") for members/clients/projects — never formatted with a unit. */
export function formatCountLabel(value: number): string {
  return String(value);
}

/** Reuses this app's existing formatFileSize() (src/lib/format.ts, already used by Attachments) — one formatting convention for "bytes as a human size" everywhere in this codebase, not a second one invented for Billing. */
export function formatStorageLabel(bytes: number): string {
  return formatFileSize(bytes);
}

export function formatLimitLabel(limit: number | null, formatter: (value: number) => string): string {
  return limit === null ? "Unlimited" : formatter(limit);
}
