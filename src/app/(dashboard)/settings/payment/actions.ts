"use server";

import { revalidatePath } from "next/cache";
import { getCurrentMembership } from "@/lib/current-user";
import { canAccessPaymentDetails } from "@/lib/organization-setup/authorization";
import { parsePaymentDetailsForm } from "@/lib/validation/payment-details";
import { upsertPaymentDetails } from "@/lib/organization-setup/payment-details";
import type { PaymentDetailsFormState } from "@/types";

const NOT_OWNER_MESSAGE = "Payment details are only available to the organization owner.";

/**
 * Customer Setup Wizard (Stage 6.2). Re-checks the OWNER-only boundary
 * independently of the page's own check (src/lib/organization-setup/
 * authorization.ts's own doc comment: never left to a single call site
 * alone) — a MEMBER/ADMIN who somehow reaches this action (a stale page,
 * a crafted request) is still rejected here, before anything is written.
 */
export async function updatePaymentDetailsAction(
  _prevState: PaymentDetailsFormState,
  formData: FormData,
): Promise<PaymentDetailsFormState> {
  const { organizationId, membership } = await getCurrentMembership();

  if (!canAccessPaymentDetails(membership.role)) {
    return { error: NOT_OWNER_MESSAGE };
  }

  const { values, fieldErrors } = parsePaymentDetailsForm(formData);
  if (Object.keys(fieldErrors).length > 0) {
    return { error: null, fieldErrors };
  }

  await upsertPaymentDetails(organizationId, values);

  revalidatePath("/settings/payment");
  revalidatePath("/dashboard");

  return { error: null, message: "Payment details saved." };
}
