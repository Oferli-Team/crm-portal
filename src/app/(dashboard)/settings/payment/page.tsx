import { getCurrentMembership } from "@/lib/current-user";
import { getPaymentDetails } from "@/lib/organization-setup/payment-details";
import { assertCanAccessPaymentDetails, OrganizationSetupAccessError } from "@/lib/organization-setup/authorization";
import { PaymentAccessDenied } from "@/components/organization-setup/payment-access-denied";
import { PaymentDetailsForm } from "./payment-details-form";

/**
 * Customer Setup Wizard (Stage 6.2). OWNER-only for both read and write —
 * the one page in this stage using Analytics' stricter pattern
 * (assertCanAccessPaymentDetails throws, caught here, rendered as a
 * dedicated Access denied state) rather than Billing's "everyone can
 * view" shape: real bank details are never fetched, let alone rendered,
 * for a MEMBER/ADMIN identity — the access check runs before
 * getPaymentDetails() is ever called, so there's no data to leak even in
 * a redacted/masked form. Staff-only by construction: this route lives
 * under (dashboard), whose layout already redirects any Client Portal-only
 * identity to /portal before this page ever renders.
 */
export default async function PaymentDetailsPage() {
  const { organizationId, membership } = await getCurrentMembership();

  try {
    assertCanAccessPaymentDetails(membership.role);
  } catch (err) {
    if (err instanceof OrganizationSetupAccessError) {
      return <PaymentAccessDenied />;
    }
    throw err;
  }

  const details = await getPaymentDetails(organizationId);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Payment receiving details</h1>
      <p className="mt-1 text-sm text-gray-500">
        Where your organization receives payments. Visible only to you, the organization owner.
      </p>
      <PaymentDetailsForm details={details} />
    </div>
  );
}
