import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEmailLegalFooterHtml, buildEmailLegalFooterText } from "@/lib/email/legal-footer";

const ENV_KEYS = ["APP_BASE_URL", "VERCEL_URL"] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
});

describe("buildEmailLegalFooterHtml", () => {
  it("links to /privacy and /terms on the resolved app base URL", () => {
    process.env.APP_BASE_URL = "https://app.example.com";

    const html = buildEmailLegalFooterHtml();

    expect(html).toContain('href="https://app.example.com/privacy"');
    expect(html).toContain('href="https://app.example.com/terms"');
    expect(html).toContain("Privacy Policy");
    expect(html).toContain("Terms of Service");
  });

  it("never mentions a product/brand name — several templates (e.g. the staff password reset email) are deliberately audience-neutral", () => {
    expect(buildEmailLegalFooterHtml()).not.toContain("Client Portal");
  });

  it("falls back to localhost when no base URL is configured", () => {
    expect(buildEmailLegalFooterHtml()).toContain('href="http://localhost:3000/privacy"');
  });
});

describe("buildEmailLegalFooterText", () => {
  it("includes both absolute links", () => {
    process.env.APP_BASE_URL = "https://app.example.com";

    const text = buildEmailLegalFooterText();

    expect(text).toContain("Privacy Policy: https://app.example.com/privacy");
    expect(text).toContain("Terms of Service: https://app.example.com/terms");
  });
});
