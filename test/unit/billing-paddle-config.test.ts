import { afterEach, describe, expect, it, vi } from "vitest";

// src/lib/billing/provider/paddle-config.ts imports the real
// "server-only" marker package — see test/unit/billing-provider-
// availability.test.ts's own header comment for why this needs
// neutralizing here rather than disabling the guard globally.
vi.mock("server-only", () => ({}));

const PADDLE_ENV_KEYS = [
  "BILLING_PROVIDER",
  "BILLING_ENVIRONMENT",
  "BILLING_API_KEY",
  "BILLING_WEBHOOK_SECRET",
  "BILLING_STARTER_PRICE_ID",
  "BILLING_PRO_PRICE_ID",
] as const;

async function importFresh() {
  vi.resetModules();
  return import("@/lib/billing/provider/paddle-config");
}

/** Sets every variable to a full, valid sandbox config, then lets each test override/unset specific ones to exercise partial-config paths. */
function stubFullValidConfig(overrides: Partial<Record<(typeof PADDLE_ENV_KEYS)[number], string>> = {}) {
  const full: Record<(typeof PADDLE_ENV_KEYS)[number], string> = {
    BILLING_PROVIDER: "PADDLE",
    BILLING_ENVIRONMENT: "sandbox",
    BILLING_API_KEY: "test-api-key",
    BILLING_WEBHOOK_SECRET: "test-webhook-secret",
    BILLING_STARTER_PRICE_ID: "test-starter-price-id",
    BILLING_PRO_PRICE_ID: "test-pro-price-id",
    ...overrides,
  };
  for (const key of PADDLE_ENV_KEYS) {
    vi.stubEnv(key, full[key]);
  }
}

describe("getPaddleProviderConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is null when nothing is configured at all", async () => {
    for (const key of PADDLE_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
    const { getPaddleProviderConfig } = await importFresh();

    expect(getPaddleProviderConfig()).toBeNull();
  });

  it("returns a full config for a complete sandbox setup", async () => {
    stubFullValidConfig({ BILLING_ENVIRONMENT: "sandbox" });
    const { getPaddleProviderConfig } = await importFresh();

    expect(getPaddleProviderConfig()).toEqual({
      environment: "sandbox",
      apiKey: "test-api-key",
      webhookSecret: "test-webhook-secret",
      priceIdByPlanKey: {
        STARTER: "test-starter-price-id",
        PRO: "test-pro-price-id",
      },
    });
  });

  it("returns a full config for a complete live setup", async () => {
    stubFullValidConfig({ BILLING_ENVIRONMENT: "live" });
    const { getPaddleProviderConfig } = await importFresh();

    expect(getPaddleProviderConfig()).toEqual({
      environment: "live",
      apiKey: "test-api-key",
      webhookSecret: "test-webhook-secret",
      priceIdByPlanKey: {
        STARTER: "test-starter-price-id",
        PRO: "test-pro-price-id",
      },
    });
  });

  it("is null when BILLING_API_KEY is missing — fail-closed, not a partial config", async () => {
    stubFullValidConfig({ BILLING_API_KEY: "" });
    const { getPaddleProviderConfig } = await importFresh();

    expect(getPaddleProviderConfig()).toBeNull();
  });

  it("is null when BILLING_WEBHOOK_SECRET is missing", async () => {
    stubFullValidConfig({ BILLING_WEBHOOK_SECRET: "" });
    const { getPaddleProviderConfig } = await importFresh();

    expect(getPaddleProviderConfig()).toBeNull();
  });

  it("is null when BILLING_STARTER_PRICE_ID is missing", async () => {
    stubFullValidConfig({ BILLING_STARTER_PRICE_ID: "" });
    const { getPaddleProviderConfig } = await importFresh();

    expect(getPaddleProviderConfig()).toBeNull();
  });

  it("is null when BILLING_PRO_PRICE_ID is missing", async () => {
    stubFullValidConfig({ BILLING_PRO_PRICE_ID: "" });
    const { getPaddleProviderConfig } = await importFresh();

    expect(getPaddleProviderConfig()).toBeNull();
  });

  it("is null for an unrecognized BILLING_ENVIRONMENT value — never guessed, never defaults to sandbox or live", async () => {
    stubFullValidConfig({ BILLING_ENVIRONMENT: "production" });
    const { getPaddleProviderConfig } = await importFresh();

    expect(getPaddleProviderConfig()).toBeNull();
  });

  it("is null when BILLING_PROVIDER is not exactly \"PADDLE\" — case-sensitive, never normalized", async () => {
    stubFullValidConfig({ BILLING_PROVIDER: "STRIPE" });
    const { getPaddleProviderConfig: getPaddleProviderConfigStripe } = await importFresh();
    expect(getPaddleProviderConfigStripe()).toBeNull();

    vi.resetModules();
    stubFullValidConfig({ BILLING_PROVIDER: "paddle" });
    const { getPaddleProviderConfig: getPaddleProviderConfigLowercase } = await importFresh();
    expect(getPaddleProviderConfigLowercase()).toBeNull();
  });

  it("is null for any other single missing field — partial config always fails closed, never returns a half-populated object", async () => {
    stubFullValidConfig({ BILLING_PROVIDER: "" });
    const { getPaddleProviderConfig } = await importFresh();

    expect(getPaddleProviderConfig()).toBeNull();
  });

  it("treats whitespace-only env values as unset, same discipline as every other platform-config field in this codebase", async () => {
    stubFullValidConfig({ BILLING_API_KEY: "   " });
    const { getPaddleProviderConfig } = await importFresh();

    expect(getPaddleProviderConfig()).toBeNull();
  });

  it("maps STARTER/PRO plan keys to their own distinct price ids, never swapped or shared", async () => {
    stubFullValidConfig({
      BILLING_STARTER_PRICE_ID: "distinct-starter-id",
      BILLING_PRO_PRICE_ID: "distinct-pro-id",
    });
    const { getPaddleProviderConfig } = await importFresh();

    const config = getPaddleProviderConfig();

    expect(config?.priceIdByPlanKey.STARTER).toBe("distinct-starter-id");
    expect(config?.priceIdByPlanKey.PRO).toBe("distinct-pro-id");
    expect(config?.priceIdByPlanKey.STARTER).not.toBe(config?.priceIdByPlanKey.PRO);
  });

  it("never logs the api key, webhook secret, or any other value it reads — full config and null paths both checked", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    stubFullValidConfig();
    const { getPaddleProviderConfig } = await importFresh();
    getPaddleProviderConfig();

    vi.resetModules();
    for (const key of PADDLE_ENV_KEYS) vi.stubEnv(key, "");
    const { getPaddleProviderConfig: getPaddleProviderConfigEmpty } = await importFresh();
    getPaddleProviderConfigEmpty();

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
