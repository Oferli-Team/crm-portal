import type { ReactNode } from "react";
import type { OnboardingStepStatus } from "@/lib/onboarding/progress";

/**
 * Purely decorative per-status glyph (`aria-hidden`) — the adjacent
 * `StatusBadge` text label is the actual accessible status conveyance
 * (Stage 3 task §14, docs/onboarding-architecture.md §12's "never
 * color-only" rule: text + icon + tone together, never color alone).
 */
/** Per-status ring color and inner glyph (Stage 5: deduplicated from four near-identical `<svg>` blocks into one shell — same visual output). `null` inner content means a plain ring, no glyph (NOT_STARTED, and the default fallback). */
const STATUS_ICON: Record<OnboardingStepStatus, { colorClass: string; dashed?: boolean; inner: ReactNode }> = {
  COMPLETE: {
    colorClass: "text-green-600",
    inner: (
      <path
        d="m8.25 12.5 2.5 2.5 5-5.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  SKIPPED: {
    colorClass: "text-gray-400",
    inner: <path d="M9.5 9.5h5M14.5 9.5 9.5 14.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />,
  },
  NOT_APPLICABLE: { colorClass: "text-gray-300", dashed: true, inner: null },
  NOT_STARTED: { colorClass: "text-gray-300", inner: null },
};

export function OnboardingStepIcon({ status }: { status: OnboardingStepStatus }) {
  const { colorClass, dashed, inner } = STATUS_ICON[status] ?? STATUS_ICON.NOT_STARTED;

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className={`mt-0.5 h-5 w-5 shrink-0 ${colorClass}`}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.75" strokeDasharray={dashed ? "2.5 2.5" : undefined} />
      {inner}
    </svg>
  );
}
