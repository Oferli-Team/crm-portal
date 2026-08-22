import "server-only";
import type { BillingProvider } from "@/generated/prisma/enums";
import type { PlanKey } from "@/lib/billing/plans";

/**
 * Sale-Ready Phase E, E2.2 (Paddle Provider Configuration Foundation).
 * Reads and validates the real-provider env vars documented in
 * `.env.example`/`docs/billing-provider-adapter.md`, and nothing else —
 * no network call, no SDK import, no Paddle account required to exist.
 *
 * As of Sale-Ready Phase E, E2.6 (Paddle Provider Resolver Activation),
 * `getBillingProviderAdapter()` (`./provider.ts`) calls this module
 * directly: a fully valid config (every field below present) resolves to
 * the real Paddle adapter; anything else (nothing set, TEST_MODE on, one
 * var missing/invalid) still resolves to the mock or the fail-closed
 * unconfigured adapter exactly as before. This module remains the single,
 * already-tested place every caller gets its validated configuration
 * from, rather than each adapter method re-reading and re-validating
 * `process.env` independently.
 */

export type PaddleEnvironment = "sandbox" | "live";

/**
 * Only these two plan keys are ever purchasable
 * (`src/lib/billing/plans.ts`'s own `billingAvailable` flag) — `TRIAL`/
 * `LEGACY` never go through checkout, so they never need a price id.
 * Keyed against `PlanKey` itself (a type-only import, `plans.ts` is not
 * modified by this module) rather than a second, independently-typed
 * `"STARTER" | "PRO"` union that could silently drift from the real
 * catalog if a plan key were ever renamed.
 */
export type PaddlePriceIdByPlanKey = Record<Extract<PlanKey, "STARTER" | "PRO">, string>;

export type PaddleProviderConfig = {
  environment: PaddleEnvironment;
  /** The provider's server-side API key. Never logged, never returned to a client, never echoed in an error message. */
  apiKey: string;
  /** Used by a future `paddle-provider.ts`'s `verifyWebhook` to compute/compare the real Paddle-Signature HMAC. Same handling rules as `apiKey`. */
  webhookSecret: string;
  priceIdByPlanKey: PaddlePriceIdByPlanKey;
};

/** The only value `BillingProvider` (the Prisma enum) currently has — see `prisma/schema.prisma`. Typed against that enum, not an independently-invented string, so this comparison would fail to compile if the enum's own spelling ever changed. */
const EXPECTED_PROVIDER: BillingProvider = "PADDLE";

function trimmedEnv(name: string): string | null {
  const value = process.env[name];
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isPaddleEnvironment(value: string | null): value is PaddleEnvironment {
  return value === "sandbox" || value === "live";
}

/**
 * Returns a fully-validated config only when every one of `BILLING_PROVIDER`
 * (must equal `"PADDLE"` exactly — case-sensitive, matching the Prisma
 * enum's own casing, never guessed or normalized), `BILLING_ENVIRONMENT`
 * (must be exactly `"sandbox"` or `"live"`), `BILLING_API_KEY`,
 * `BILLING_WEBHOOK_SECRET`, `BILLING_STARTER_PRICE_ID`, and
 * `BILLING_PRO_PRICE_ID` are present — `null` otherwise, for absolutely
 * any other reason (nothing set, one var missing, an unrecognized
 * `BILLING_ENVIRONMENT` value, `BILLING_PROVIDER` set to something other
 * than `"PADDLE"`). Never throws during normal rendering, never makes a
 * network call — deliberate fail-closed-on-partial-config behavior, the
 * same discipline `unconfigured-provider.ts` already models: a caller
 * that gets `null` back must treat Paddle as entirely not configured, not
 * attempt to use whichever fields happened to be present.
 */
export function getPaddleProviderConfig(): PaddleProviderConfig | null {
  const provider = trimmedEnv("BILLING_PROVIDER");
  if (provider !== EXPECTED_PROVIDER) return null;

  const environment = trimmedEnv("BILLING_ENVIRONMENT");
  if (!isPaddleEnvironment(environment)) return null;

  const apiKey = trimmedEnv("BILLING_API_KEY");
  const webhookSecret = trimmedEnv("BILLING_WEBHOOK_SECRET");
  const starterPriceId = trimmedEnv("BILLING_STARTER_PRICE_ID");
  const proPriceId = trimmedEnv("BILLING_PRO_PRICE_ID");

  if (!apiKey || !webhookSecret || !starterPriceId || !proPriceId) return null;

  return {
    environment,
    apiKey,
    webhookSecret,
    priceIdByPlanKey: {
      STARTER: starterPriceId,
      PRO: proPriceId,
    },
  };
}
