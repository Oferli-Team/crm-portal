import { afterEach, describe, expect, it } from "vitest";
import { isPlatformAdmin, requirePlatformAdmin } from "@/lib/platform-admin/authorization";
import { setMockAuthUser, resetAuthMock } from "../../support/auth-mock";
import { RedirectSignal, resetNavigationMock } from "../../support/navigation-mock";

const ORIGINAL_PLATFORM_ADMIN_EMAILS = process.env.PLATFORM_ADMIN_EMAILS;

afterEach(() => {
  resetAuthMock();
  resetNavigationMock();
  if (ORIGINAL_PLATFORM_ADMIN_EMAILS === undefined) {
    delete process.env.PLATFORM_ADMIN_EMAILS;
  } else {
    process.env.PLATFORM_ADMIN_EMAILS = ORIGINAL_PLATFORM_ADMIN_EMAILS;
  }
});

async function catchRedirect(fn: () => Promise<unknown>): Promise<RedirectSignal> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(RedirectSignal);
  return caught as RedirectSignal;
}

describe("isPlatformAdmin", () => {
  it("is false for everyone when PLATFORM_ADMIN_EMAILS is unset", () => {
    delete process.env.PLATFORM_ADMIN_EMAILS;
    expect(isPlatformAdmin("owner@example.com")).toBe(false);
  });

  it("is false for everyone when PLATFORM_ADMIN_EMAILS is an empty string", () => {
    process.env.PLATFORM_ADMIN_EMAILS = "";
    expect(isPlatformAdmin("owner@example.com")).toBe(false);
  });

  it("is true for an exact match", () => {
    process.env.PLATFORM_ADMIN_EMAILS = "owner@example.com";
    expect(isPlatformAdmin("owner@example.com")).toBe(true);
  });

  it("matches case-insensitively", () => {
    process.env.PLATFORM_ADMIN_EMAILS = "Owner@Example.com";
    expect(isPlatformAdmin("owner@example.com")).toBe(true);
    expect(isPlatformAdmin("OWNER@EXAMPLE.COM")).toBe(true);
  });

  it("supports multiple comma-separated emails, trimming whitespace", () => {
    process.env.PLATFORM_ADMIN_EMAILS = " owner@example.com , second@example.com ";
    expect(isPlatformAdmin("owner@example.com")).toBe(true);
    expect(isPlatformAdmin("second@example.com")).toBe(true);
    expect(isPlatformAdmin("third@example.com")).toBe(false);
  });

  it("is false for a plausible non-match, and for null/undefined", () => {
    process.env.PLATFORM_ADMIN_EMAILS = "owner@example.com";
    expect(isPlatformAdmin("not-owner@example.com")).toBe(false);
    expect(isPlatformAdmin(null)).toBe(false);
    expect(isPlatformAdmin(undefined)).toBe(false);
  });
});

describe("requirePlatformAdmin", () => {
  it("redirects to /login when there is no authenticated user", async () => {
    process.env.PLATFORM_ADMIN_EMAILS = "owner@example.com";
    setMockAuthUser(null);

    const signal = await catchRedirect(() => requirePlatformAdmin());
    expect(signal.url).toBe("/login");
  });

  it("redirects an authenticated but non-allowlisted user to /dashboard, never a visible access-denied page", async () => {
    process.env.PLATFORM_ADMIN_EMAILS = "owner@example.com";
    setMockAuthUser({ id: "11111111-1111-1111-1111-111111111111", email: "someone-else@example.com" });

    const signal = await catchRedirect(() => requirePlatformAdmin());
    expect(signal.url).toBe("/dashboard");
  });

  it("resolves for an allowlisted, authenticated user — never redirects", async () => {
    process.env.PLATFORM_ADMIN_EMAILS = "owner@example.com";
    setMockAuthUser({ id: "22222222-2222-2222-2222-222222222222", email: "owner@example.com" });

    const result = await requirePlatformAdmin();
    expect(result).toEqual({ email: "owner@example.com" });
  });

  it("never resolves organizational context — it has no dependency on an active organization cookie", async () => {
    // Deliberately no setMockActiveOrganization()/actAs() call — if
    // requirePlatformAdmin ever started depending on org resolution, this
    // test would start failing/throwing for an unrelated reason, catching
    // an architectural regression the type signature alone wouldn't.
    process.env.PLATFORM_ADMIN_EMAILS = "owner@example.com";
    setMockAuthUser({ id: "33333333-3333-3333-3333-333333333333", email: "owner@example.com" });

    await expect(requirePlatformAdmin()).resolves.toEqual({ email: "owner@example.com" });
  });
});
