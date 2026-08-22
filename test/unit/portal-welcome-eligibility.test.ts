import { describe, expect, it } from "vitest";
import { isPortalWelcomeEligible, PORTAL_WELCOME_WINDOW_MS } from "@/components/portal/portal-welcome-eligibility";

/**
 * Client Portal welcome banner — Stage 4 (docs/onboarding-architecture.md
 * §17). This is the ENTIRE decision logic behind the banner — no table, no
 * migration, purely a function of `PortalUser.createdAt` vs "now".
 */

describe("isPortalWelcomeEligible", () => {
  it("a PortalUser created this instant is eligible", () => {
    const now = new Date("2026-01-08T12:00:00.000Z");
    expect(isPortalWelcomeEligible(now, now)).toBe(true);
  });

  it("a PortalUser created just under the window ago is still eligible", () => {
    const now = new Date("2026-01-08T12:00:00.000Z");
    const createdAt = new Date(now.getTime() - (PORTAL_WELCOME_WINDOW_MS - 1));
    expect(isPortalWelcomeEligible(createdAt, now)).toBe(true);
  });

  it("a PortalUser created exactly at the window boundary is no longer eligible", () => {
    const now = new Date("2026-01-08T12:00:00.000Z");
    const createdAt = new Date(now.getTime() - PORTAL_WELCOME_WINDOW_MS);
    expect(isPortalWelcomeEligible(createdAt, now)).toBe(false);
  });

  it("a PortalUser created well outside the window (e.g. one year ago) is not eligible", () => {
    const now = new Date("2026-01-08T12:00:00.000Z");
    const createdAt = new Date("2025-01-08T12:00:00.000Z");
    expect(isPortalWelcomeEligible(createdAt, now)).toBe(false);
  });

  it("the window is exactly 7 days, matching this codebase's own invitation-validity convention", () => {
    expect(PORTAL_WELCOME_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
