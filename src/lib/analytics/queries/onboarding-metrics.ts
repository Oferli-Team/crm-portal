import { getOrganizationOnboardingProgress } from "@/lib/onboarding/progress";
import type { OnboardingMetrics } from "../types";

/**
 * Analytics Stage 1 (docs/analytics-architecture.md §5.6). Deliberately a
 * thin wrapper over src/lib/onboarding/progress.ts's own
 * `getOrganizationOnboardingProgress()` — that function is already the
 * one place "percent" has a single, tested definition (excludes WELCOME,
 * includes FINISH — see that module's own doc comment); re-deriving it
 * from raw OrganizationOnboardingStep rows here would risk silently
 * drifting from what the Dashboard's own onboarding card actually shows.
 * Takes no `client`/transaction parameter — that function always reads
 * through the shared `prisma` singleton, matching every other read-only
 * server call site in the onboarding module.
 */
export async function getOnboardingMetrics(organizationId: string): Promise<OnboardingMetrics> {
  const progress = await getOrganizationOnboardingProgress(organizationId);
  return {
    percent: progress.percent,
    completedCount: progress.completedCount,
    totalCount: progress.totalCount,
  };
}
