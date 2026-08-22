"use server";

import { revalidatePath } from "next/cache";
import { getCurrentMembership } from "@/lib/current-user";
import { canManageCompanyProfile } from "@/lib/organization-setup/authorization";
import { parseCompanyProfileForm } from "@/lib/validation/company-profile";
import { upsertCompanyProfile } from "@/lib/organization-setup/company-profile";
import { uploadOrganizationLogo } from "@/lib/organization-setup/logo-mutations";
import type { CompanyProfileFormState, LogoUploadState } from "@/types";

const NOT_OWNER_MESSAGE = "Only the organization owner can update company details.";

/**
 * Customer Setup Wizard (Stage 6.2). organizationId/role are never
 * accepted as parameters — always resolved server-side via
 * getCurrentMembership(), the same non-negotiable rule every existing
 * Server Action in this codebase already follows.
 */
export async function updateCompanyProfileAction(
  _prevState: CompanyProfileFormState,
  formData: FormData,
): Promise<CompanyProfileFormState> {
  const { organizationId, membership } = await getCurrentMembership();

  if (!canManageCompanyProfile(membership.role)) {
    return { error: NOT_OWNER_MESSAGE };
  }

  const { values, fieldErrors } = parseCompanyProfileForm(formData);
  if (Object.keys(fieldErrors).length > 0) {
    return { error: null, fieldErrors };
  }

  await upsertCompanyProfile(organizationId, values);

  revalidatePath("/settings/company");
  // The onboarding checklist's COMPANY_PROFILE step reads live from
  // OrganizationProfile — this flips it to Done on next render, the same
  // "no separate onboarding-specific write" model every computed step
  // already uses (docs/onboarding-architecture.md §4/§9).
  revalidatePath("/dashboard");

  return { error: null, message: "Company profile saved." };
}

/**
 * Sale-Ready Phase A.1 (Business Identity), PR4 — backend only; no UI
 * widget calls this yet (see this PR's own scope). Same
 * "organizationId/role always resolved server-side, never accepted as a
 * parameter" rule as updateCompanyProfileAction above.
 */
export async function uploadCompanyLogoAction(
  _prevState: LogoUploadState,
  formData: FormData,
): Promise<LogoUploadState> {
  const { user, organizationId, membership } = await getCurrentMembership();

  if (!canManageCompanyProfile(membership.role)) {
    return { error: NOT_OWNER_MESSAGE };
  }

  const result = await uploadOrganizationLogo({ organizationId, actorId: user.id, formData });

  if (result.error === null) {
    revalidatePath("/settings/company");
  }
  return result;
}
