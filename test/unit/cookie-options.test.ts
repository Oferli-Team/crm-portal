import { afterEach, describe, expect, it, vi } from "vitest";
import { getSupabaseCookieOptions } from "@/lib/supabase/cookie-options";

// vi.stubEnv/vi.unstubAllEnvs is Vitest's own env-restore mechanism — no
// custom helper needed on top of it (see Stage 3's test/support/fixtures.ts
// for what *is* shared, and why this isn't).
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getSupabaseCookieOptions", () => {
  it("hardens the cookie for production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const options = getSupabaseCookieOptions();

    expect(options.httpOnly).toBe(true);
    expect(options.secure).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
    expect(options).not.toHaveProperty("domain");
    expect(options).not.toHaveProperty("maxAge");
    expect(options).not.toHaveProperty("expires");
  });

  it("keeps httpOnly/sameSite/path but drops secure for local http development", () => {
    vi.stubEnv("NODE_ENV", "development");
    const options = getSupabaseCookieOptions();

    expect(options.httpOnly).toBe(true);
    expect(options.secure).toBe(false);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
  });

  it("is deterministic for the same NODE_ENV", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(getSupabaseCookieOptions()).toEqual(getSupabaseCookieOptions());
  });

  it("never sets a Domain or an explicit Max-Age/Expires, in either environment", () => {
    for (const env of ["production", "development", "test"]) {
      vi.stubEnv("NODE_ENV", env);
      const options = getSupabaseCookieOptions();
      expect(options).not.toHaveProperty("domain");
      expect(options).not.toHaveProperty("maxAge");
      expect(options).not.toHaveProperty("expires");
    }
  });
});
