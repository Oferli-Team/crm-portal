import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPlatformDomainConfig } from "@/lib/legal/platform-config";

const DOMAIN_ENV_KEYS = ["APP_BASE_URL", "VERCEL_URL"] as const;

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of DOMAIN_ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of DOMAIN_ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
});

describe("getPlatformDomainConfig", () => {
  it("is honestly 'Not configured' with the localhost fallback when neither env var is set — matches local dev, never fabricates a domain", () => {
    expect(getPlatformDomainConfig()).toEqual({
      currentDomain: "localhost:3000",
      defaultVercelDomain: null,
      customDomain: null,
      domainStatus: "Not configured",
      httpsEnabled: false,
      deploymentUrl: "http://localhost:3000",
    });
  });

  it("reports 'Default domain' from VERCEL_URL alone — every real Vercel deployment has this, custom domain or not", () => {
    process.env.VERCEL_URL = "my-app-abc123.vercel.app";

    expect(getPlatformDomainConfig()).toEqual({
      currentDomain: "my-app-abc123.vercel.app",
      defaultVercelDomain: "my-app-abc123.vercel.app",
      customDomain: null,
      domainStatus: "Default domain",
      httpsEnabled: true,
      deploymentUrl: "https://my-app-abc123.vercel.app",
    });
  });

  it("prefers a well-formed APP_BASE_URL as the custom domain, reporting 'Custom domain configured', while still surfacing VERCEL_URL's own default domain fact alongside it", () => {
    process.env.APP_BASE_URL = "https://app.acme.example";
    process.env.VERCEL_URL = "my-app-abc123.vercel.app";

    expect(getPlatformDomainConfig()).toEqual({
      currentDomain: "app.acme.example",
      defaultVercelDomain: "my-app-abc123.vercel.app",
      customDomain: "app.acme.example",
      domainStatus: "Custom domain configured",
      httpsEnabled: true,
      deploymentUrl: "https://app.acme.example",
    });
  });

  it("strips a trailing slash from APP_BASE_URL when building deploymentUrl/currentDomain", () => {
    process.env.APP_BASE_URL = "https://app.acme.example/";

    const config = getPlatformDomainConfig();

    expect(config.deploymentUrl).toBe("https://app.acme.example");
    expect(config.currentDomain).toBe("app.acme.example");
  });

  it("falls back to VERCEL_URL, not a fabricated custom domain, when APP_BASE_URL is malformed — an honest 'Default domain' rather than a broken value passed through", () => {
    process.env.APP_BASE_URL = "not-a-url";
    process.env.VERCEL_URL = "my-app-abc123.vercel.app";

    const config = getPlatformDomainConfig();

    expect(config.customDomain).toBeNull();
    expect(config.domainStatus).toBe("Default domain");
    expect(config.deploymentUrl).toBe("https://my-app-abc123.vercel.app");
  });

  it("treats whitespace-only env values as unset, same as every other platform-config field", () => {
    process.env.APP_BASE_URL = "   ";
    process.env.VERCEL_URL = "  ";

    expect(getPlatformDomainConfig()).toEqual({
      currentDomain: "localhost:3000",
      defaultVercelDomain: null,
      customDomain: null,
      domainStatus: "Not configured",
      httpsEnabled: false,
      deploymentUrl: "http://localhost:3000",
    });
  });

  it("reports HTTPS as not enabled for a deliberately http:// APP_BASE_URL — never assumes https regardless of what's configured", () => {
    process.env.APP_BASE_URL = "http://app.acme.example";

    const config = getPlatformDomainConfig();

    expect(config.httpsEnabled).toBe(false);
    expect(config.domainStatus).toBe("Custom domain configured");
  });
});
