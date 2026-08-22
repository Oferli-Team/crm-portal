"use server";

import { revalidatePath } from "next/cache";
import { getCurrentMembership } from "@/lib/current-user";
import { canManageDomainSettings } from "@/lib/organization-setup/authorization";
import { parseDomainSettingsForm } from "@/lib/validation/domain-settings";
import { upsertDomainSettings } from "@/lib/organization-setup/domain-settings";
import type { DomainSettingsFormState } from "@/types";

const NOT_OWNER_MESSAGE = "Only the organization owner can update domain settings.";

export async function updateDomainSettingsAction(
  _prevState: DomainSettingsFormState,
  formData: FormData,
): Promise<DomainSettingsFormState> {
  const { organizationId, membership } = await getCurrentMembership();

  if (!canManageDomainSettings(membership.role)) {
    return { error: NOT_OWNER_MESSAGE };
  }

  const { values, fieldErrors } = parseDomainSettingsForm(formData);
  if (Object.keys(fieldErrors).length > 0) {
    return { error: null, fieldErrors };
  }

  const result = await upsertDomainSettings(organizationId, values);
  if (!result.ok) {
    return { error: null, fieldErrors: { customDomain: result.error } };
  }

  revalidatePath("/settings/domain");
  revalidatePath("/dashboard");

  return { error: null, message: "Domain settings saved." };
}
