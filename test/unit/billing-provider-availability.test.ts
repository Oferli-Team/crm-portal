import { afterEach, describe, expect, it, vi } from "vitest";

// src/lib/billing/provider-availability.ts (transitively, via
// src/lib/billing/provider/provider.ts) imports the real "server-only"
// marker package — see test/unit/cron-auth.test.ts's own header comment
// for why this needs neutralizing here rather than disabling the guard
// globally.
vi.mock("server-only", () => ({}));

async function importFresh() {
  vi.resetModules();
  return import("@/lib/billing/provider-availability");
}

describe("getBillingProviderAvailability", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is unconfigured outside TEST_MODE — no provider is connected", async () => {
    vi.stubEnv("TEST_MODE", "");
    const { getBillingProviderAvailability } = await importFresh();

    const result = await getBillingProviderAvailability();

    expect(result).toEqual({
      configured: false,
      provider: "PADDLE",
      checkoutAvailable: false,
      portalAvailable: false,
    });
  });

  it("resolves to the mock provider (configured) under TEST_MODE", async () => {
    vi.stubEnv("TEST_MODE", "1");
    const { getBillingProviderAvailability } = await importFresh();

    const result = await getBillingProviderAvailability();

    expect(result).toEqual({
      configured: true,
      provider: "PADDLE",
      checkoutAvailable: true,
      portalAvailable: true,
    });
  });
});
