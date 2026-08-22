import type { BillingPageViewModel } from "@/lib/billing/view-model";
import { PlanCard } from "./plan-card";

export function PlansSection({ data }: { data: BillingPageViewModel }) {
  return (
    <section aria-labelledby="billing-plans-heading">
      <h2 id="billing-plans-heading" className="text-base font-semibold text-gray-900">
        Plans
      </h2>
      <p className="mt-1 text-sm text-gray-500">
        {data.providerAvailability.configured
          ? ""
          : "Connect a billing provider to publish pricing."}
      </p>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {data.availablePlans.map((plan) => (
          <PlanCard key={plan.planKey} plan={plan} permissions={data.permissions} />
        ))}
      </div>
    </section>
  );
}
