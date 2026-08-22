import { describe, expect, it, vi } from "vitest";

// src/lib/billing/provider/unconfigured-provider.ts imports "server-only" —
// see test/unit/cron-auth.test.ts's own header comment.
vi.mock("server-only", () => ({}));

import { createUnconfiguredBillingProvider, BillingProviderUnconfiguredError } from "@/lib/billing/provider/unconfigured-provider";

describe("createUnconfiguredBillingProvider", () => {
  it("reports kind: 'unconfigured'", () => {
    expect(createUnconfiguredBillingProvider().kind).toBe("unconfigured");
  });

  it("createCheckoutSession throws BillingProviderUnconfiguredError", async () => {
    const provider = createUnconfiguredBillingProvider();
    await expect(
      provider.createCheckoutSession({
        organizationId: "org_1",
        planKey: "STARTER",
        returnUrl: "/settings/billing",
        cancelUrl: "/settings/billing",
        existingProviderCustomerId: null,
      }),
    ).rejects.toBeInstanceOf(BillingProviderUnconfiguredError);
  });

  it("createCustomerPortalSession throws BillingProviderUnconfiguredError", async () => {
    const provider = createUnconfiguredBillingProvider();
    await expect(
      provider.createCustomerPortalSession({ organizationId: "org_1", providerCustomerId: "cus_1", returnUrl: "/settings/billing" }),
    ).rejects.toBeInstanceOf(BillingProviderUnconfiguredError);
  });

  it("verifyWebhook never verifies anything", () => {
    const provider = createUnconfiguredBillingProvider();
    expect(provider.verifyWebhook({ rawBody: "{}", headers: new Headers() }).verified).toBe(false);
  });

  it("parseWebhookEvent always returns null", () => {
    const provider = createUnconfiguredBillingProvider();
    expect(provider.parseWebhookEvent("{}")).toBeNull();
  });
});
