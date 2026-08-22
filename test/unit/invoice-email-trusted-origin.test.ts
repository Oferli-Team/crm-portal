import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// TEST_MODE and NODE_ENV are read at call time (not module-load time) by
// resolveTrustedInvoiceEmailOrigin() itself, but TEST_MODE's own exported
// const is still computed once at import — see test/unit/invoice-pdf-
// storage.test.ts's own identical precedent — so process.env.TEST_MODE is
// set before the dynamic import in each describe block that needs it.

const ORIGINAL_ENV = {
  APP_BASE_URL: process.env.APP_BASE_URL,
  VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  TEST_MODE: process.env.TEST_MODE,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// NODE_ENV is typed read-only on process.env in this project — use
// Vitest's own vi.stubEnv/vi.unstubAllEnvs mechanism for it (see
// test/unit/cookie-options.test.ts's own identical precedent), never a
// direct assignment.
beforeEach(() => {
  delete process.env.APP_BASE_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.TEST_MODE;
  vi.stubEnv("NODE_ENV", "production");
  vi.resetModules();
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("resolveTrustedInvoiceEmailOrigin — APP_BASE_URL precedence", () => {
  it("returns the exact origin for a valid explicit HTTPS APP_BASE_URL", async () => {
    process.env.APP_BASE_URL = "https://app.example.com";
    const { resolveTrustedInvoiceEmailOrigin } = await import("@/lib/invoices/email/trusted-origin");
    expect(resolveTrustedInvoiceEmailOrigin()).toBe("https://app.example.com");
  });

  it("normalizes a trailing slash", async () => {
    process.env.APP_BASE_URL = "https://app.example.com/";
    const { resolveTrustedInvoiceEmailOrigin } = await import("@/lib/invoices/email/trusted-origin");
    expect(resolveTrustedInvoiceEmailOrigin()).toBe("https://app.example.com");
  });

  it("discards a path, query, and fragment, keeping only the origin", async () => {
    process.env.APP_BASE_URL = "https://app.example.com/some/path?query=1#fragment";
    const { resolveTrustedInvoiceEmailOrigin } = await import("@/lib/invoices/email/trusted-origin");
    expect(resolveTrustedInvoiceEmailOrigin()).toBe("https://app.example.com");
  });

  it("rejects credentials embedded in the origin", async () => {
    process.env.APP_BASE_URL = "https://user:pass@app.example.com";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "fallback.example.com";
    const { resolveTrustedInvoiceEmailOrigin } = await import("@/lib/invoices/email/trusted-origin");
    // Falls through to the next candidate rather than trusting credentials.
    expect(resolveTrustedInvoiceEmailOrigin()).toBe("https://fallback.example.com");
  });

  it("rejects a bare hostname with no scheme, falling through to the next candidate", async () => {
    process.env.APP_BASE_URL = "app.example.com";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "fallback.example.com";
    const { resolveTrustedInvoiceEmailOrigin } = await import("@/lib/invoices/email/trusted-origin");
    expect(resolveTrustedInvoiceEmailOrigin()).toBe("https://fallback.example.com");
  });

  it("rejects a non-HTTP(S) scheme (ftp), falling through to the next candidate", async () => {
    process.env.APP_BASE_URL = "ftp://app.example.com";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "fallback.example.com";
    const { resolveTrustedInvoiceEmailOrigin } = await import("@/lib/invoices/email/trusted-origin");
    expect(resolveTrustedInvoiceEmailOrigin()).toBe("https://fallback.example.com");
  });

  it("accepts an explicit HTTP (not just HTTPS) origin", async () => {
    process.env.APP_BASE_URL = "http://internal.example.com";
    const { resolveTrustedInvoiceEmailOrigin } = await import("@/lib/invoices/email/trusted-origin");
    expect(resolveTrustedInvoiceEmailOrigin()).toBe("http://internal.example.com");
  });
});

describe("resolveTrustedInvoiceEmailOrigin — VERCEL_PROJECT_PRODUCTION_URL fallback", () => {
  it("normalizes the stable production hostname (no scheme in the raw value) to an HTTPS origin", async () => {
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "my-site.com";
    const { resolveTrustedInvoiceEmailOrigin } = await import("@/lib/invoices/email/trusted-origin");
    expect(resolveTrustedInvoiceEmailOrigin()).toBe("https://my-site.com");
  });

  it("is used only when APP_BASE_URL is not set", async () => {
    process.env.APP_BASE_URL = "https://explicit.example.com";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "my-site.com";
    const { resolveTrustedInvoiceEmailOrigin } = await import("@/lib/invoices/email/trusted-origin");
    expect(resolveTrustedInvoiceEmailOrigin()).toBe("https://explicit.example.com");
  });
});

describe("resolveTrustedInvoiceEmailOrigin — production with no configuration", () => {
  it("returns null when neither APP_BASE_URL nor VERCEL_PROJECT_PRODUCTION_URL is set, in production", async () => {
    const { resolveTrustedInvoiceEmailOrigin } = await import("@/lib/invoices/email/trusted-origin");
    expect(resolveTrustedInvoiceEmailOrigin()).toBeNull();
  });
});

describe("resolveTrustedInvoiceEmailOrigin — development/TEST_MODE localhost fallback", () => {
  it("returns localhost in development with no other configuration", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { resolveTrustedInvoiceEmailOrigin } = await import("@/lib/invoices/email/trusted-origin");
    expect(resolveTrustedInvoiceEmailOrigin()).toBe("http://localhost:3000");
  });

  it("returns localhost under TEST_MODE even though NODE_ENV reports production (matches next start's own real behavior)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.TEST_MODE = "1";
    const { resolveTrustedInvoiceEmailOrigin } = await import("@/lib/invoices/email/trusted-origin");
    expect(resolveTrustedInvoiceEmailOrigin()).toBe("http://localhost:3000");
  });

  it("does not use the localhost fallback in production outside TEST_MODE", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { resolveTrustedInvoiceEmailOrigin } = await import("@/lib/invoices/email/trusted-origin");
    expect(resolveTrustedInvoiceEmailOrigin()).toBeNull();
  });

  it("explicit configuration still wins over the localhost fallback in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    process.env.APP_BASE_URL = "https://explicit.example.com";
    const { resolveTrustedInvoiceEmailOrigin } = await import("@/lib/invoices/email/trusted-origin");
    expect(resolveTrustedInvoiceEmailOrigin()).toBe("https://explicit.example.com");
  });
});

describe("resolveTrustedInvoiceEmailOrigin — no request-header input exists", () => {
  it("the module takes zero arguments — there is no way to pass a Host/X-Forwarded-Host header into it", async () => {
    const { resolveTrustedInvoiceEmailOrigin } = await import("@/lib/invoices/email/trusted-origin");
    expect(resolveTrustedInvoiceEmailOrigin.length).toBe(0);
  });
});
