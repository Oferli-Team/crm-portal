import "server-only";
import { TEST_MODE } from "@/lib/test-mode";
import type { BillingProviderAdapter } from "./types";
import { createMockBillingProvider } from "./mock-provider";
import { createUnconfiguredBillingProvider } from "./unconfigured-provider";
import { createPaddleBillingProvider } from "./paddle-provider";
import { getPaddleProviderConfig } from "./paddle-config";

/**
 * Sale-Ready Phase E, E2.6 (Paddle Provider Resolver Activation). The
 * single resolver every checkout/portal action and the webhook route
 * calls — never construct an adapter any other way.
 *
 * Behavior, strictly in this order:
 *   1. TEST_MODE on → MockBillingProvider (deterministic, no network
 *      calls) — takes priority over a real Paddle config even if one
 *      happens to be present in the environment, so a local/test
 *      environment can never accidentally talk to a real Paddle account
 *      just because its own `.env` also has billing vars set for some
 *      other reason.
 *   2. Otherwise, `getPaddleProviderConfig()` (`./paddle-config.ts`) —
 *      the single source of truth for whether every one of
 *      `BILLING_PROVIDER`/`BILLING_ENVIRONMENT`/`BILLING_API_KEY`/
 *      `BILLING_WEBHOOK_SECRET`/`BILLING_STARTER_PRICE_ID`/
 *      `BILLING_PRO_PRICE_ID` is present and valid. A fully valid config
 *      → the real `createPaddleBillingProvider(config)`. This module
 *      itself never reads a `BILLING_*` env var directly, and never
 *      constructs a config object of its own — the exact object
 *      `getPaddleProviderConfig()` returns is the only thing ever passed
 *      to `createPaddleBillingProvider`, so there is no path to a
 *      partially-configured or hand-assembled Paddle adapter.
 *   3. Any other case (nothing set, one var missing, an unrecognized
 *      `BILLING_ENVIRONMENT`, `BILLING_PROVIDER` set to something other
 *      than `"PADDLE"`) → `createPaddleBillingProvider` is never called
 *      at all; the resolver falls through to
 *      `UnconfiguredBillingProvider`, which fails closed on every method
 *      (see that file's own header comment).
 *
 * Importing this module must never throw or fail at import time, and
 * calling `getBillingProviderAdapter()` must never make a network call —
 * `getPaddleProviderConfig()` only reads `process.env` (no I/O), and
 * `createPaddleBillingProvider`'s own default SDK-client parameter
 * (`createPaddleSdkClient`, `./paddle-client.ts`) only constructs the SDK
 * object (confirmed against the SDK's own source: the constructor stores
 * the API key/options and builds resource wrappers, no `fetch`/`await`
 * anywhere in it) — every actual Paddle API request happens lazily,
 * later, only when a specific adapter method
 * (`createCheckoutSession`/`createCustomerPortalSession`) is actually
 * called by a real checkout/portal action.
 */
export function getBillingProviderAdapter(): BillingProviderAdapter {
  if (TEST_MODE) {
    return createMockBillingProvider();
  }

  const config = getPaddleProviderConfig();
  if (config) {
    return createPaddleBillingProvider(config);
  }

  return createUnconfiguredBillingProvider();
}
