import { describe, expect, it } from "vitest";
import { resolveCheckoutBridgeParams, buildSuccessUrl } from "@/app/billing/checkout/checkout-bridge";

function params(overrides: Partial<Parameters<typeof resolveCheckoutBridgeParams>[0]> = {}) {
  return {
    transactionId: "txn_01hxxx",
    environment: "sandbox",
    returnUrl: "/settings/billing?checkout=success",
    cancelUrl: "/settings/billing?checkout=cancel",
    ...overrides,
  };
}

describe("resolveCheckoutBridgeParams", () => {
  it("resolves a fully well-formed set of params", () => {
    const result = resolveCheckoutBridgeParams(params());

    expect(result).toEqual({
      ok: true,
      bridge: {
        transactionId: "txn_01hxxx",
        environment: "sandbox",
        returnPath: "/settings/billing?checkout=success",
        cancelPath: "/settings/billing?checkout=cancel",
      },
    });
  });

  it("resolves a live environment the same way", () => {
    const result = resolveCheckoutBridgeParams(params({ environment: "live" }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.bridge.environment).toBe("live");
  });

  it("fails closed when transactionId is missing (null)", () => {
    expect(resolveCheckoutBridgeParams(params({ transactionId: null }))).toEqual({
      ok: false,
      reason: "missing_transaction_id",
    });
  });

  it("fails closed when transactionId is an empty string", () => {
    expect(resolveCheckoutBridgeParams(params({ transactionId: "" }))).toEqual({
      ok: false,
      reason: "missing_transaction_id",
    });
  });

  it("fails closed when transactionId is whitespace-only", () => {
    expect(resolveCheckoutBridgeParams(params({ transactionId: "   " }))).toEqual({
      ok: false,
      reason: "missing_transaction_id",
    });
  });

  it("fails closed when environment is missing", () => {
    expect(resolveCheckoutBridgeParams(params({ environment: null }))).toEqual({
      ok: false,
      reason: "missing_or_invalid_environment",
    });
  });

  it("fails closed when environment is an unrecognized value, never guessing a default", () => {
    expect(resolveCheckoutBridgeParams(params({ environment: "production" }))).toEqual({
      ok: false,
      reason: "missing_or_invalid_environment",
    });
  });

  it("falls back returnUrl to /settings/billing when missing", () => {
    const result = resolveCheckoutBridgeParams(params({ returnUrl: null }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.bridge.returnPath).toBe("/settings/billing");
  });

  it("falls back cancelUrl to /settings/billing when missing", () => {
    const result = resolveCheckoutBridgeParams(params({ cancelUrl: null }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.bridge.cancelPath).toBe("/settings/billing");
  });

  it("re-sanitizes an unsafe returnUrl rather than trusting the query string, since this page is a public, unauthenticated route", () => {
    const result = resolveCheckoutBridgeParams(params({ returnUrl: "https://evil.com" }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.bridge.returnPath).toBe("/settings/billing");
  });

  it("re-sanitizes a protocol-relative returnUrl (//evil.com)", () => {
    const result = resolveCheckoutBridgeParams(params({ returnUrl: "//evil.com" }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.bridge.returnPath).toBe("/settings/billing");
  });

  it("re-sanitizes an unsafe cancelUrl", () => {
    const result = resolveCheckoutBridgeParams(params({ cancelUrl: "https://evil.com/steal" }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.bridge.cancelPath).toBe("/settings/billing");
  });

  it("keeps returnPath/cancelPath relative (never turns them into an absolute URL)", () => {
    const result = resolveCheckoutBridgeParams(params());

    expect(result.ok).toBe(true);
    expect(result.ok && result.bridge.returnPath.startsWith("/")).toBe(true);
    expect(result.ok && result.bridge.cancelPath.startsWith("/")).toBe(true);
  });
});

describe("buildSuccessUrl", () => {
  it("resolves a relative path to an absolute URL against the given origin", () => {
    expect(buildSuccessUrl("/settings/billing?checkout=success", "https://app.example.com")).toBe(
      "https://app.example.com/settings/billing?checkout=success",
    );
  });

  it("resolves against a different buyer-supplied origin", () => {
    expect(buildSuccessUrl("/settings/billing", "https://buyer-app.example.org")).toBe("https://buyer-app.example.org/settings/billing");
  });
});
