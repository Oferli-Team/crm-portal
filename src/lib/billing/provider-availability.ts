import "server-only";
import type { BillingProvider } from "@/generated/prisma/enums";
import { getBillingProviderAdapter } from "./provider/provider";

/**
 * Billing & Subscriptions Stage 4 (docs/billing-architecture.md's Stage 4
 * note, this stage's own §9/§15). Stage 3 introduced this as an
 * always-`false` stub with one documented seam for later; Stage 4 is that
 * seam being filled in — this now delegates to the provider registry
 * (`src/lib/billing/provider/provider.ts`) instead of hardcoding a value,
 * so it reports `configured: true` whenever TEST_MODE resolves to the mock
 * adapter, and `configured: false` in any real deployment until a real
 * provider is actually connected (Stage 5+). Every caller (the billing
 * page's view-model builder, the checkout/portal Server Actions) is
 * unchanged by this — they already only ever branch on `.configured`.
 */
export type BillingProviderAvailability = {
  configured: boolean;
  provider: BillingProvider;
  checkoutAvailable: boolean;
  portalAvailable: boolean;
};

export async function getBillingProviderAvailability(): Promise<BillingProviderAvailability> {
  const adapter = getBillingProviderAdapter();
  const configured = adapter.kind !== "unconfigured";
  return {
    configured,
    provider: adapter.name,
    checkoutAvailable: configured,
    portalAvailable: configured,
  };
}
