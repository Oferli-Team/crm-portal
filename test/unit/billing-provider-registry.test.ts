import { describe, expect, it, vi, afterEach } from "vitest";

// src/lib/billing/provider/provider.ts (transitively, via paddle-provider.ts
// and paddle-client.ts) imports the real "server-only" marker package —
// see test/unit/cron-auth.test.ts's own header comment for why this needs
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
  return import("@/lib/billing/provider/provider");
}

/**
 * Sets every variable to a full, valid Paddle config — sandbox by
 * default — then lets each test override/unset specific ones to
 * exercise partial-config paths. Every value is an obvious fake/test
 * value, never anything resembling a real Paddle credential (this file
 * makes no network call regardless — see the "no network activity" test
 * below — but the same "never a real-looking secret in source" discipline
 * as every other billing test file still applies).
 */
function stubFullValidPaddleConfig(overrides: Partial<Record<(typeof PADDLE_ENV_KEYS)[number], string>> = {}) {
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

describe("getBillingProviderAdapter", () => {
  afterEach(() => vi.unstubAllEnvs());

  describe("no configuration", () => {
    it("resolves to the unconfigured provider when nothing is set", async () => {
      vi.stubEnv("TEST_MODE", "");
      const { getBillingProviderAdapter } = await importFresh();
      expect(getBillingProviderAdapter().kind).toBe("unconfigured");
    });
  });

  describe("TEST_MODE", () => {
    it("resolves to the mock provider under TEST_MODE with no Paddle config present", async () => {
      vi.stubEnv("TEST_MODE", "1");
      const { getBillingProviderAdapter } = await importFresh();
      expect(getBillingProviderAdapter().kind).toBe("mock");
    });

    it("resolves to the mock provider under TEST_MODE even when a full, valid Paddle config is ALSO present — TEST_MODE takes priority", async () => {
      vi.stubEnv("TEST_MODE", "1");
      stubFullValidPaddleConfig();
      const { getBillingProviderAdapter } = await importFresh();
      const adapter = getBillingProviderAdapter();
      expect(adapter.kind).toBe("mock");
      expect(adapter.kind).not.toBe("paddle");
    });
  });

  describe("full, valid Paddle config (no TEST_MODE)", () => {
    it("resolves to the real Paddle adapter for a full sandbox config", async () => {
      vi.stubEnv("TEST_MODE", "");
      stubFullValidPaddleConfig({ BILLING_ENVIRONMENT: "sandbox" });
      const { getBillingProviderAdapter } = await importFresh();
      const adapter = getBillingProviderAdapter();
      expect(adapter.kind).toBe("paddle");
      expect(adapter.name).toBe("PADDLE");
    });

    it("resolves to the real Paddle adapter for a full live config", async () => {
      vi.stubEnv("TEST_MODE", "");
      stubFullValidPaddleConfig({ BILLING_ENVIRONMENT: "live" });
      const { getBillingProviderAdapter } = await importFresh();
      const adapter = getBillingProviderAdapter();
      expect(adapter.kind).toBe("paddle");
      expect(adapter.name).toBe("PADDLE");
    });
  });

  describe("partial/invalid Paddle config (no TEST_MODE) — every case fails closed to unconfigured, never a partial Paddle adapter", () => {
    it("falls back to unconfigured when BILLING_API_KEY is missing", async () => {
      vi.stubEnv("TEST_MODE", "");
      stubFullValidPaddleConfig({ BILLING_API_KEY: "" });
      const { getBillingProviderAdapter } = await importFresh();
      expect(getBillingProviderAdapter().kind).toBe("unconfigured");
    });

    it("falls back to unconfigured when BILLING_WEBHOOK_SECRET is missing", async () => {
      vi.stubEnv("TEST_MODE", "");
      stubFullValidPaddleConfig({ BILLING_WEBHOOK_SECRET: "" });
      const { getBillingProviderAdapter } = await importFresh();
      expect(getBillingProviderAdapter().kind).toBe("unconfigured");
    });

    it("falls back to unconfigured when BILLING_STARTER_PRICE_ID is missing", async () => {
      vi.stubEnv("TEST_MODE", "");
      stubFullValidPaddleConfig({ BILLING_STARTER_PRICE_ID: "" });
      const { getBillingProviderAdapter } = await importFresh();
      expect(getBillingProviderAdapter().kind).toBe("unconfigured");
    });

    it("falls back to unconfigured when BILLING_PRO_PRICE_ID is missing", async () => {
      vi.stubEnv("TEST_MODE", "");
      stubFullValidPaddleConfig({ BILLING_PRO_PRICE_ID: "" });
      const { getBillingProviderAdapter } = await importFresh();
      expect(getBillingProviderAdapter().kind).toBe("unconfigured");
    });

    it("falls back to unconfigured when BILLING_ENVIRONMENT is an unrecognized value, never guessing sandbox or live", async () => {
      vi.stubEnv("TEST_MODE", "");
      stubFullValidPaddleConfig({ BILLING_ENVIRONMENT: "production" });
      const { getBillingProviderAdapter } = await importFresh();
      expect(getBillingProviderAdapter().kind).toBe("unconfigured");
    });

    it("falls back to unconfigured when BILLING_ENVIRONMENT is missing entirely", async () => {
      vi.stubEnv("TEST_MODE", "");
      stubFullValidPaddleConfig({ BILLING_ENVIRONMENT: "" });
      const { getBillingProviderAdapter } = await importFresh();
      expect(getBillingProviderAdapter().kind).toBe("unconfigured");
    });

    it("falls back to unconfigured when BILLING_PROVIDER is wrong", async () => {
      vi.stubEnv("TEST_MODE", "");
      stubFullValidPaddleConfig({ BILLING_PROVIDER: "STRIPE" });
      const { getBillingProviderAdapter } = await importFresh();
      expect(getBillingProviderAdapter().kind).toBe("unconfigured");
    });

    it("falls back to unconfigured when BILLING_PROVIDER is lowercase (case-sensitive match required)", async () => {
      vi.stubEnv("TEST_MODE", "");
      stubFullValidPaddleConfig({ BILLING_PROVIDER: "paddle" });
      const { getBillingProviderAdapter } = await importFresh();
      expect(getBillingProviderAdapter().kind).toBe("unconfigured");
    });

    it("falls back to unconfigured when a required variable is whitespace-only", async () => {
      vi.stubEnv("TEST_MODE", "");
      stubFullValidPaddleConfig({ BILLING_API_KEY: "   " });
      const { getBillingProviderAdapter } = await importFresh();
      expect(getBillingProviderAdapter().kind).toBe("unconfigured");
    });

    it("falls back to unconfigured when nothing at all is set and TEST_MODE is off", async () => {
      vi.stubEnv("TEST_MODE", "");
      for (const key of PADDLE_ENV_KEYS) vi.stubEnv(key, "");
      const { getBillingProviderAdapter } = await importFresh();
      expect(getBillingProviderAdapter().kind).toBe("unconfigured");
    });
  });

  describe("no network activity", () => {
    it("makes no network call when resolving a full, valid Paddle config — construction only, no request", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        throw new Error("getBillingProviderAdapter() must never make a network call during resolution");
      });

      vi.stubEnv("TEST_MODE", "");
      stubFullValidPaddleConfig();
      const { getBillingProviderAdapter } = await importFresh();

      expect(() => getBillingProviderAdapter()).not.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
    });

    it("makes no network call when resolving to unconfigured", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        throw new Error("getBillingProviderAdapter() must never make a network call during resolution");
      });

      vi.stubEnv("TEST_MODE", "");
      const { getBillingProviderAdapter } = await importFresh();

      expect(() => getBillingProviderAdapter()).not.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
    });

    it("makes no network call when resolving to the mock provider", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        throw new Error("getBillingProviderAdapter() must never make a network call during resolution");
      });

      vi.stubEnv("TEST_MODE", "1");
      const { getBillingProviderAdapter } = await importFresh();

      expect(() => getBillingProviderAdapter()).not.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
    });
  });
});
