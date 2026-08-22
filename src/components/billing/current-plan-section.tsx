import { StatusBadge } from "@/components/ui/status-badge";
import type { BillingPageViewModel } from "@/lib/billing/view-model";
import { NoticeBanner } from "./notice-banner";
import { ManageSubscriptionButton } from "./manage-subscription-button";

export function CurrentPlanSection({ data }: { data: BillingPageViewModel }) {
  return (
    <section aria-labelledby="billing-current-plan-heading" className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="billing-current-plan-heading" className="text-base font-semibold text-gray-900">
            {data.currentPlanName}
          </h2>
          <div className="mt-1.5">
            <StatusBadge status={data.statusLabel} />
          </div>
        </div>

        {data.permissions.canManageSubscription ? (
          <ManageSubscriptionButton />
        ) : (
          <div className="text-right">
            <button
              type="button"
              disabled
              aria-disabled="true"
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-400 disabled:cursor-not-allowed"
            >
              Manage subscription
            </button>
            <p className="mt-1 text-xs text-gray-500">Only the organization owner can manage billing.</p>
          </div>
        )}
      </div>

      <div className="mt-4">
        <NoticeBanner notice={data.statusNotice} />
      </div>

      <dl className="mt-4 space-y-1 text-sm text-gray-600">
        {data.trialEndsAt && !data.trialExpired && (
          <div>
            <dt className="sr-only">Trial ends</dt>
            <dd>
              Trial ends on {data.trialEndsAt.toLocaleDateString()}
              {data.trialDaysRemaining !== null &&
                ` (${data.trialDaysRemaining} ${data.trialDaysRemaining === 1 ? "day" : "days"} remaining)`}
              .
            </dd>
          </div>
        )}

        {data.cancelAtPeriodEnd && data.currentPeriodEnd && (
          <div>
            <dt className="sr-only">Subscription ends</dt>
            <dd>Your subscription will end on {data.currentPeriodEnd.toLocaleDateString()}.</dd>
          </div>
        )}

        {!data.cancelAtPeriodEnd && data.currentPeriodEnd && data.statusLabel === "ACTIVE" && (
          <div>
            <dt className="sr-only">Renews</dt>
            <dd>Renews on {data.currentPeriodEnd.toLocaleDateString()}.</dd>
          </div>
        )}

        {data.gracePeriodEndsAt && (
          <div>
            <dt className="sr-only">Grace period ends</dt>
            <dd>Grace period ends on {data.gracePeriodEndsAt.toLocaleDateString()}.</dd>
          </div>
        )}
      </dl>
    </section>
  );
}
