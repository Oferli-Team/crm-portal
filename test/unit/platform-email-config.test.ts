import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPlatformEmailConfig } from "@/lib/legal/platform-config";

const EMAIL_ENV_KEYS = [
  "PLATFORM_SUPPORT_EMAIL",
  "PLATFORM_BILLING_EMAIL",
  "PLATFORM_REPLY_TO_EMAIL",
  "INVITATION_FROM_EMAIL",
  "RESEND_API_KEY",
] as const;

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of EMAIL_ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of EMAIL_ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
});

describe("getPlatformEmailConfig", () => {
  it("is entirely honest 'Not set'/'Not configured' when nothing is configured — never fabricates an address or a provider", () => {
    const config = getPlatformEmailConfig();

    expect(config).toEqual({
      supportEmail: null,
      billingEmail: null,
      senderEmail: null,
      replyToEmail: null,
      providerName: "Resend",
      providerConfigured: false,
      senderConfigured: false,
      replyToConfigured: false,
    });
  });

  it("prefers every explicitly configured env var, and reports Reply-To as explicitly configured (not a fallback) when set", () => {
    process.env.PLATFORM_SUPPORT_EMAIL = "support@acme.example";
    process.env.PLATFORM_BILLING_EMAIL = "billing@acme.example";
    process.env.PLATFORM_REPLY_TO_EMAIL = "replies@acme.example";
    process.env.INVITATION_FROM_EMAIL = "Acme <invites@acme.example>";
    process.env.RESEND_API_KEY = "re_test_key";

    expect(getPlatformEmailConfig()).toEqual({
      supportEmail: "support@acme.example",
      billingEmail: "billing@acme.example",
      senderEmail: "invites@acme.example",
      replyToEmail: "replies@acme.example",
      providerName: "Resend",
      providerConfigured: true,
      senderConfigured: true,
      replyToConfigured: true,
    });
  });

  it("falls Reply-To Email back to the sender address, and reports that fallback honestly, when PLATFORM_REPLY_TO_EMAIL is unset", () => {
    process.env.INVITATION_FROM_EMAIL = "invites@acme.example";

    const config = getPlatformEmailConfig();

    expect(config.replyToEmail).toBe("invites@acme.example");
    expect(config.replyToConfigured).toBe(false);
  });

  it("reuses getPlatformLegalConfig()'s supportEmail — including its own INVITATION_FROM_EMAIL fallback — rather than a second independent source", () => {
    process.env.INVITATION_FROM_EMAIL = "invites@acme.example";

    expect(getPlatformEmailConfig().supportEmail).toBe("invites@acme.example");
  });

  it("never invents a billing contact from the support or sender address — stays null until explicitly set", () => {
    process.env.PLATFORM_SUPPORT_EMAIL = "support@acme.example";
    process.env.INVITATION_FROM_EMAIL = "invites@acme.example";

    expect(getPlatformEmailConfig().billingEmail).toBeNull();
  });

  it("treats whitespace-only env values as unset, same as every other platform-config field", () => {
    process.env.PLATFORM_BILLING_EMAIL = "   ";
    process.env.PLATFORM_REPLY_TO_EMAIL = "  ";
    process.env.RESEND_API_KEY = "   ";

    const config = getPlatformEmailConfig();

    expect(config.billingEmail).toBeNull();
    expect(config.replyToEmail).toBeNull();
    expect(config.providerConfigured).toBe(false);
  });

  it("reports the sender as missing when INVITATION_FROM_EMAIL is malformed, matching extractEmailAddress's own honesty rule", () => {
    process.env.INVITATION_FROM_EMAIL = "not-an-email";

    const config = getPlatformEmailConfig();

    expect(config.senderEmail).toBeNull();
    expect(config.senderConfigured).toBe(false);
    expect(config.replyToEmail).toBeNull();
  });
});
