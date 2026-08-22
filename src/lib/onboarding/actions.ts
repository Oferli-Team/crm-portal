"use server";

import { revalidatePath } from "next/cache";
import type { OnboardingStepKey } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { isOnboardingStepAvailable, ONBOARDING_STEPS } from "./steps";

/**
 * Onboarding Stage 2 (docs/onboarding-architecture.md §9/§13). No UI calls
 * these yet — this is the backend contract Stage 3's checklist card will
 * import directly, built and fully tested ahead of it, the same
 * "backend before UI" staging Comments/Search/Billing all already used.
 *
 * Every action here resolves `organizationId` via
 * `getCurrentUserOrganization()` — never accepted as a parameter, never
 * trusted from client input. No role check: per §13's own explicit
 * decision, dismissing a UI nudge is flat-access, not a trust/authority
 * action — any current member of the active organization may skip or
 * acknowledge a step, the same "ordinary business content" access level
 * Client/Project/Task/Invoice CRUD already has (docs/comments-
 * architecture.md §0.3, cited by the design doc's own §13).
 *
 * No Activity row, no Notification, no email — §14/§15 of the design doc
 * are both explicit that onboarding's own skip/dismiss/acknowledge
 * actions produce neither.
 */

export type OnboardingActionResult = { ok: true } | { ok: false; message: string };

const INVALID_STEP_MESSAGE = "Unknown onboarding step.";
const NOT_SKIPPABLE_MESSAGE = "That step can't be skipped.";
const UNAVAILABLE_STEP_MESSAGE = "That step isn't available yet.";

function isValidStepKey(value: string): value is OnboardingStepKey {
  return Object.prototype.hasOwnProperty.call(ONBOARDING_STEPS, value);
}

/**
 * The one write this whole module ever performs — an upsert with an empty
 * `update`, so a repeat call for the same (organization, step) is a
 * database-native no-op via `@@unique([organizationId, step])`'s own
 * ON CONFLICT DO UPDATE resolution, never a second row and never a thrown
 * constraint error. Writing this row for a step that's already Complete
 * by real data (§12's own "no duplicated progress state" invariant) is
 * harmless: `buildOnboardingProgress` always checks computed-done first
 * (src/lib/onboarding/progress.ts), so a stale skip row for an
 * already-complete step is simply never consulted.
 */
async function recordOnboardingStep(organizationId: string, step: OnboardingStepKey): Promise<void> {
  await prisma.organizationOnboardingStep.upsert({
    where: { organizationId_step: { organizationId, step } },
    create: { organizationId, step },
    update: {},
  });
}

/**
 * Marks one step explicitly skipped for the caller's own active
 * organization. Only a step the catalog itself marks `skippable` and
 * currently available (every step, as of Sale-Ready Phase E, E3.3 — see
 * `isOnboardingStepAvailable`, §16) may ever be skipped; WELCOME/FINISH
 * are rejected here by construction (they're never `skippable`), not as
 * a special case.
 */
export async function skipOnboardingStepAction(stepKey: string): Promise<OnboardingActionResult> {
  if (!isValidStepKey(stepKey)) {
    return { ok: false, message: INVALID_STEP_MESSAGE };
  }

  const definition = ONBOARDING_STEPS[stepKey];
  if (!definition.skippable) {
    return { ok: false, message: NOT_SKIPPABLE_MESSAGE };
  }
  if (!isOnboardingStepAvailable(stepKey)) {
    return { ok: false, message: UNAVAILABLE_STEP_MESSAGE };
  }

  const { organizationId } = await getCurrentUserOrganization();
  await recordOnboardingStep(organizationId, stepKey);
  // The checklist card only ever renders on /dashboard (Stage 3) — same
  // single-route revalidation shape markNotificationReadAction already
  // uses for the bell it affects.
  revalidatePath("/dashboard");
  return { ok: true };
}

/**
 * Acknowledges the Welcome step. Deliberately parameterless (never a
 * client-supplied step key) — there is no allowlist to bypass because
 * there is nothing to choose.
 */
export async function acknowledgeOnboardingWelcomeAction(): Promise<OnboardingActionResult> {
  const { organizationId } = await getCurrentUserOrganization();
  await recordOnboardingStep(organizationId, "WELCOME");
  revalidatePath("/dashboard");
  return { ok: true };
}

/**
 * Dismisses the whole onboarding checklist (docs/onboarding-architecture.md
 * §3 path 2 / §11) — represented as a single FINISH row, deliberately not
 * a separate `Organization` column (see that model's own schema.prisma
 * comment for why a second flag would just say the same fact twice).
 * Idempotent, parameterless, same shape as the Welcome acknowledgment
 * above. Does not require every other step to be Complete/Skipped first —
 * §3 explicitly allows dismissing early, "regardless of how many
 * individual steps are actually done."
 */
export async function finishOnboardingAction(): Promise<OnboardingActionResult> {
  const { organizationId } = await getCurrentUserOrganization();
  await recordOnboardingStep(organizationId, "FINISH");
  revalidatePath("/dashboard");
  return { ok: true };
}
