import { formatFileSize } from "@/lib/format";
import type { PlanCardViewModel, BillingManagementPermissions } from "@/lib/billing/view-model";
import { PlanActionButton } from "./plan-action-button";

const NOT_OWNER_REASON = "Only the organization owner can manage billing.";

export function PlanCard({
  plan,
  permissions,
}: {
  plan: PlanCardViewModel;
  permissions: BillingManagementPermissions;
}) {
  const disabledReason = plan.isCurrentPlan
    ? undefined
    : !permissions.canManagePlan
      ? NOT_OWNER_REASON
      : undefined;

  return (
    <div
      className={`flex flex-col rounded-lg border bg-white p-5 ${
        plan.isCurrentPlan ? "border-gray-900" : "border-gray-200"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-gray-900">{plan.displayName}</h3>
        {plan.isCurrentPlan && (
          <span className="inline-flex items-center rounded-full bg-gray-900 px-2 py-0.5 text-xs font-medium text-white">
            Current plan
          </span>
        )}
      </div>

      <p className="mt-1 text-sm text-gray-500">{plan.description}</p>

      <ul className="mt-4 space-y-1 text-sm text-gray-700">
        <li>{plan.maxMembers} members</li>
        <li>{plan.maxClients === null ? "Unlimited clients" : `${plan.maxClients} clients`}</li>
        <li>{plan.maxProjects === null ? "Unlimited projects" : `${plan.maxProjects} projects`}</li>
        <li>{formatFileSize(plan.maxStorageBytes)} storage</li>
      </ul>

      {/* No fake dollar amounts — this stage's own §7 rule: only ever this generic copy until a real provider is connected. */}
      <p className="mt-4 text-xs text-gray-500">Pricing configured by the product owner.</p>

      <div className="mt-4">
        <PlanActionButton
          planKey={plan.planKey}
          label={plan.ctaLabel}
          disabled={plan.ctaDisabled}
          disabledReason={disabledReason}
        />
      </div>
    </div>
  );
}
