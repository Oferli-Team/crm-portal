import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPlatformBranding } from "@/lib/legal/platform-config";

const BRANDING_ENV_KEYS = ["PLATFORM_NAME", "PLATFORM_TAGLINE", "PLATFORM_LOGO_URL", "PLATFORM_FAVICON_URL"] as const;

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of BRANDING_ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of BRANDING_ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
});

describe("getPlatformBranding", () => {
  it("falls back to the site config's name/description, and null for the two URLs, when nothing is configured", () => {
    const branding = getPlatformBranding();

    expect(branding).toEqual({
      name: "Client Portal CRM",
      tagline: "A lightweight CRM for freelancers and small agencies to manage clients, projects, tasks, and invoices.",
      logoUrl: null,
      faviconUrl: null,
    });
  });

  it("prefers every explicitly configured env var over its fallback", () => {
    process.env.PLATFORM_NAME = "Acme Platform";
    process.env.PLATFORM_TAGLINE = "Run your agency, your way.";
    process.env.PLATFORM_LOGO_URL = "https://cdn.example.com/logo.png";
    process.env.PLATFORM_FAVICON_URL = "https://cdn.example.com/favicon.ico";

    expect(getPlatformBranding()).toEqual({
      name: "Acme Platform",
      tagline: "Run your agency, your way.",
      logoUrl: "https://cdn.example.com/logo.png",
      faviconUrl: "https://cdn.example.com/favicon.ico",
    });
  });

  it("treats whitespace-only env values as unset, same as every other platform-config field", () => {
    process.env.PLATFORM_NAME = "   ";
    process.env.PLATFORM_LOGO_URL = "  ";

    const branding = getPlatformBranding();

    expect(branding.name).toBe("Client Portal CRM");
    expect(branding.logoUrl).toBeNull();
  });

  it("never fabricates a logo or favicon URL — both stay null until explicitly configured", () => {
    const branding = getPlatformBranding();
    expect(branding.logoUrl).toBeNull();
    expect(branding.faviconUrl).toBeNull();
  });
});
