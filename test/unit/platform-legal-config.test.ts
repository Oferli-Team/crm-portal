import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPlatformLegalConfig } from "@/lib/legal/platform-config";

const LEGAL_ENV_KEYS = [
  "PLATFORM_LEGAL_NAME",
  "PLATFORM_LEGAL_ADDRESS",
  "PLATFORM_SUPPORT_EMAIL",
  "PLATFORM_JURISDICTION",
  "PRIVACY_POLICY_EFFECTIVE_DATE",
  "TOS_EFFECTIVE_DATE",
  "INVITATION_FROM_EMAIL",
  "PLATFORM_NAME",
] as const;

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of LEGAL_ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of LEGAL_ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
});

describe("getPlatformLegalConfig", () => {
  it("falls back to the site name and safe, honest defaults when nothing is configured — never a fabricated address or mailbox", () => {
    const config = getPlatformLegalConfig();

    expect(config.legalName).toBe("Client Portal CRM");
    expect(config.legalAddress).toBeNull();
    expect(config.supportEmail).toBeNull();
    expect(config.jurisdiction).toBe("the jurisdiction in which the Service operator is located");
    expect(config.privacyEffectiveDate).toBe("August 9, 2026");
    expect(config.tosEffectiveDate).toBe("August 9, 2026");
  });

  it("prefers every explicitly configured env var over its fallback", () => {
    process.env.PLATFORM_LEGAL_NAME = "Acme Legal Co";
    process.env.PLATFORM_LEGAL_ADDRESS = "123 Main St, Springfield";
    process.env.PLATFORM_SUPPORT_EMAIL = "privacy@acme.example";
    process.env.PLATFORM_JURISDICTION = "the State of Delaware, USA";
    process.env.PRIVACY_POLICY_EFFECTIVE_DATE = "January 1, 2027";
    process.env.TOS_EFFECTIVE_DATE = "January 2, 2027";

    const config = getPlatformLegalConfig();

    expect(config).toEqual({
      legalName: "Acme Legal Co",
      legalAddress: "123 Main St, Springfield",
      supportEmail: "privacy@acme.example",
      jurisdiction: "the State of Delaware, USA",
      privacyEffectiveDate: "January 1, 2027",
      tosEffectiveDate: "January 2, 2027",
    });
  });

  it("falls back the support email to the address portion of INVITATION_FROM_EMAIL when PLATFORM_SUPPORT_EMAIL is unset", () => {
    process.env.INVITATION_FROM_EMAIL = "Client Portal CRM <invites@example.com>";

    expect(getPlatformLegalConfig().supportEmail).toBe("invites@example.com");
  });

  it("treats a bare address INVITATION_FROM_EMAIL (no display name) the same way", () => {
    process.env.INVITATION_FROM_EMAIL = "invites@example.com";

    expect(getPlatformLegalConfig().supportEmail).toBe("invites@example.com");
  });

  it("never fabricates a support email from a malformed INVITATION_FROM_EMAIL", () => {
    process.env.INVITATION_FROM_EMAIL = "not-an-email";

    expect(getPlatformLegalConfig().supportEmail).toBeNull();
  });

  it("treats whitespace-only env values as unset", () => {
    process.env.PLATFORM_LEGAL_NAME = "   ";
    process.env.PLATFORM_LEGAL_ADDRESS = "  ";

    const config = getPlatformLegalConfig();

    expect(config.legalName).toBe("Client Portal CRM");
    expect(config.legalAddress).toBeNull();
  });

  it("Sale-Ready Phase D, D2: legalName falls back through PLATFORM_NAME (Branding) when PLATFORM_LEGAL_NAME is unset — one name, not two independent facts", () => {
    process.env.PLATFORM_NAME = "Acme Platform";

    expect(getPlatformLegalConfig().legalName).toBe("Acme Platform");
  });

  it("PLATFORM_LEGAL_NAME still wins over PLATFORM_NAME when both are set — legal identity can differ from the marketing name", () => {
    process.env.PLATFORM_NAME = "Acme Platform";
    process.env.PLATFORM_LEGAL_NAME = "Acme Legal Entity LLC";

    expect(getPlatformLegalConfig().legalName).toBe("Acme Legal Entity LLC");
  });
});
