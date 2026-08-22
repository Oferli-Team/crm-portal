import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPlatformDeploymentConfig } from "@/lib/legal/platform-config";

const DEPLOYMENT_ENV_KEYS = [
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_GIT_PROVIDER",
  "VERCEL_GIT_REPO_OWNER",
  "VERCEL_GIT_REPO_SLUG",
] as const;

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of DEPLOYMENT_ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of DEPLOYMENT_ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
});

describe("getPlatformDeploymentConfig", () => {
  it("is entirely honest 'Not set' outside Vercel — every field null, matching local dev", () => {
    expect(getPlatformDeploymentConfig()).toEqual({
      environment: null,
      commitSha: null,
      commitShaShort: null,
      commitUrl: null,
    });
  });

  it("builds a real GitHub commit URL only once provider/owner/repo/sha are all present and the provider is confirmed github", () => {
    process.env.VERCEL_ENV = "production";
    process.env.VERCEL_GIT_COMMIT_SHA = "abcdef1234567890abcdef1234567890abcdef12";
    process.env.VERCEL_GIT_PROVIDER = "github";
    process.env.VERCEL_GIT_REPO_OWNER = "acme";
    process.env.VERCEL_GIT_REPO_SLUG = "client-portal-crm";

    expect(getPlatformDeploymentConfig()).toEqual({
      environment: "production",
      commitSha: "abcdef1234567890abcdef1234567890abcdef12",
      commitShaShort: "abcdef1",
      commitUrl: "https://github.com/acme/client-portal-crm/commit/abcdef1234567890abcdef1234567890abcdef12",
    });
  });

  it("never fabricates a GitHub URL for a non-github provider — commitSha still surfaces, commitUrl stays null", () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "abcdef1234567890abcdef1234567890abcdef12";
    process.env.VERCEL_GIT_PROVIDER = "gitlab";
    process.env.VERCEL_GIT_REPO_OWNER = "acme";
    process.env.VERCEL_GIT_REPO_SLUG = "client-portal-crm";

    const config = getPlatformDeploymentConfig();

    expect(config.commitSha).toBe("abcdef1234567890abcdef1234567890abcdef12");
    expect(config.commitShaShort).toBe("abcdef1");
    expect(config.commitUrl).toBeNull();
  });

  it("never guesses a commit URL when the repo owner or slug is missing, even with a confirmed github provider", () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "abcdef1234567890abcdef1234567890abcdef12";
    process.env.VERCEL_GIT_PROVIDER = "github";
    process.env.VERCEL_GIT_REPO_OWNER = "acme";
    // VERCEL_GIT_REPO_SLUG deliberately left unset.

    expect(getPlatformDeploymentConfig().commitUrl).toBeNull();
  });

  it("treats whitespace-only env values as unset, same as every other platform-config field", () => {
    process.env.VERCEL_ENV = "   ";
    process.env.VERCEL_GIT_COMMIT_SHA = "  ";

    expect(getPlatformDeploymentConfig()).toEqual({
      environment: null,
      commitSha: null,
      commitShaShort: null,
      commitUrl: null,
    });
  });
});
