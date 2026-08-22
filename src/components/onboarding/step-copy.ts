import type { OnboardingStepKey } from "@/generated/prisma/enums";

/**
 * Stage 3 UI-owned copy — one short sentence per step, distinct from
 * `ONBOARDING_STEPS[key].label` (src/lib/onboarding/steps.ts), which is the
 * backend's own short title, not a full row description. Kept here, not in
 * the Stage 2 catalog, since Stage 3 is UI-only and this stage's task
 * explicitly scopes it to "use only Stage 2 backend."
 */
export const ONBOARDING_STEP_DESCRIPTIONS: Record<OnboardingStepKey, string> = {
  WELCOME: "A quick checklist to help you get the most out of your workspace.",
  COMPANY_PROFILE: "Add your legal name, country, currency, and time zone.",
  PAYMENT_DETAILS: "Tell clients where to send your payments.",
  DOMAIN_SETUP: "Review your workspace address and an optional custom domain.",
  CREATE_CLIENT: "Add the people or businesses you work with.",
  CREATE_PROJECT: "Organize your work into projects for each client.",
  CREATE_TASK: "Break a project down into tasks you can track.",
  INVITE_TEAMMATE: "Bring a colleague into your organization.",
  INVITE_PORTAL_USER: "Give a client secure access to their own portal.",
  REVIEW_BILLING: "Review your plan and billing details.",
  FINISH: "Hide this checklist once you're all set — you can always come back.",
};
