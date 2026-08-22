import { afterEach, describe, expect, it, vi } from "vitest";

// src/lib/billing/platform-billing-config.ts imports the real
// "server-only" marker package (transitively, via src/lib/billing/
// provider/provider.ts) — see test/unit/billing-provider-availability
// .test.ts's own header comment for why this needs neutralizing here
// rather than disabling the guard globally.
vi.mock("server-only", () => ({}));

async function importFresh() {
  vi.resetModules();
  return import("@/lib/billing/platform-billing-config");
}

describe("getPlatformBillingConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is honestly 'Not configured'/'Disabled' outside TEST_MODE — no real provider is connected yet, matching getBillingProviderAvailability's own unconfigured state", async () => {
    vi.stubEnv("TEST_MODE", "");
    const { getPlatformBillingConfig } = await importFresh();

    const config = await getPlatformBillingConfig();

    expect(config).toEqual({
      providerName: "Paddle",
      providerConfigured: false,
      mode: "Not configured",
      checkoutConfigured: false,
      customerPortalConfigured: false,
      webhookConfigured: false,
      planSynchronizationConfigured: false,
    });
  });

  it("reports Mode as 'Test' and every capability as configured under TEST_MODE's mock adapter", async () => {
    vi.stubEnv("TEST_MODE", "1");
    const { getPlatformBillingConfig } = await importFresh();

    const config = await getPlatformBillingConfig();

    expect(config).toEqual({
      providerName: "Paddle",
      providerConfigured: true,
      mode: "Test",
      checkoutConfigured: true,
      customerPortalConfigured: true,
      webhookConfigured: true,
      planSynchronizationConfigured: true,
    });
  });

  it("never reports 'Live' mode under TEST_MODE — the mock adapter takes priority over any Paddle config, even a full 'live' one", async () => {
    vi.stubEnv("TEST_MODE", "1");
    vi.stubEnv("BILLING_PROVIDER", "PADDLE");
    vi.stubEnv("BILLING_ENVIRONMENT", "live");
    vi.stubEnv("BILLING_API_KEY", "test-api-key");
    vi.stubEnv("BILLING_WEBHOOK_SECRET", "test-webhook-secret");
    vi.stubEnv("BILLING_STARTER_PRICE_ID", "test-starter-price-id");
    vi.stubEnv("BILLING_PRO_PRICE_ID", "test-pro-price-id");
    const { getPlatformBillingConfig } = await importFresh();

    const config = await getPlatformBillingConfig();

    expect(config.mode).toBe("Test");
  });

  it("reports Mode as 'Sandbox' (E2.6) for a full, valid Paddle config with BILLING_ENVIRONMENT=sandbox", async () => {
    vi.stubEnv("TEST_MODE", "");
    vi.stubEnv("BILLING_PROVIDER", "PADDLE");
    vi.stubEnv("BILLING_ENVIRONMENT", "sandbox");
    vi.stubEnv("BILLING_API_KEY", "test-api-key");
    vi.stubEnv("BILLING_WEBHOOK_SECRET", "test-webhook-secret");
    vi.stubEnv("BILLING_STARTER_PRICE_ID", "test-starter-price-id");
    vi.stubEnv("BILLING_PRO_PRICE_ID", "test-pro-price-id");
    const { getPlatformBillingConfig } = await importFresh();

    const config = await getPlatformBillingConfig();

    expect(config).toEqual({
      providerName: "Paddle",
      providerConfigured: true,
      mode: "Sandbox",
      checkoutConfigured: true,
      customerPortalConfigured: true,
      webhookConfigured: true,
      planSynchronizationConfigured: true,
    });
  });

  it("reports Mode as 'Live' (E2.6) for a full, valid Paddle config with BILLING_ENVIRONMENT=live", async () => {
    vi.stubEnv("TEST_MODE", "");
    vi.stubEnv("BILLING_PROVIDER", "PADDLE");
    vi.stubEnv("BILLING_ENVIRONMENT", "live");
    vi.stubEnv("BILLING_API_KEY", "test-api-key");
    vi.stubEnv("BILLING_WEBHOOK_SECRET", "test-webhook-secret");
    vi.stubEnv("BILLING_STARTER_PRICE_ID", "test-starter-price-id");
    vi.stubEnv("BILLING_PRO_PRICE_ID", "test-pro-price-id");
    const { getPlatformBillingConfig } = await importFresh();

    const config = await getPlatformBillingConfig();

    expect(config).toEqual({
      providerName: "Paddle",
      providerConfigured: true,
      mode: "Live",
      checkoutConfigured: true,
      customerPortalConfigured: true,
      webhookConfigured: true,
      planSynchronizationConfigured: true,
    });
  });

  it("never displays a secret or price id — only providerName/mode/booleans are ever present on the returned object", async () => {
    vi.stubEnv("TEST_MODE", "");
    vi.stubEnv("BILLING_PROVIDER", "PADDLE");
    vi.stubEnv("BILLING_ENVIRONMENT", "sandbox");
    vi.stubEnv("BILLING_API_KEY", "test-api-key-should-never-appear");
    vi.stubEnv("BILLING_WEBHOOK_SECRET", "test-webhook-secret-should-never-appear");
    vi.stubEnv("BILLING_STARTER_PRICE_ID", "test-starter-price-id-should-never-appear");
    vi.stubEnv("BILLING_PRO_PRICE_ID", "test-pro-price-id-should-never-appear");
    const { getPlatformBillingConfig } = await importFresh();

    const config = await getPlatformBillingConfig();

    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain("should-never-appear");
    expect(Object.keys(config).sort()).toEqual(
      [
        "checkoutConfigured",
        "customerPortalConfigured",
        "mode",
        "planSynchronizationConfigured",
        "providerConfigured",
        "providerName",
        "webhookConfigured",
      ].sort(),
    );
  });
});
