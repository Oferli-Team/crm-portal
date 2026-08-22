import "server-only";
import type {
  BillingProviderAdapter,
  BillingCheckoutSessionInput,
  BillingCheckoutSession,
  BillingPortalSessionInput,
  BillingPortalSession,
  WebhookVerificationInput,
  WebhookVerificationResult,
  NormalizedBillingEvent,
} from "./types";

/**
 * Billing & Subscriptions Stage 4. The adapter every non-TEST_MODE
 * environment resolves to until a real provider is actually connected
 * (Stage 5+). Every method fails closed and loudly — this adapter is not
 * meant to ever actually be invoked: every call site
 * (`requestPlanChangeAction`, `manageSubscriptionAction`, the webhook
 * route) checks `getBillingProviderAvailability().configured` first and
 * returns its own controlled "not configured" result without ever
 * reaching an adapter method. These throws exist as a defense-in-depth
 * backstop against a future call site that forgets that check, not as the
 * primary safety mechanism.
 */
export class BillingProviderUnconfiguredError extends Error {
  constructor() {
    super("Billing provider is not configured.");
    this.name = "BillingProviderUnconfiguredError";
  }
}

export function createUnconfiguredBillingProvider(): BillingProviderAdapter {
  return {
    kind: "unconfigured",
    name: "PADDLE",

    async createCheckoutSession(input: BillingCheckoutSessionInput): Promise<BillingCheckoutSession> {
      void input; // Interface conformance only — this adapter never actually runs (see this file's own header comment).
      throw new BillingProviderUnconfiguredError();
    },

    async createCustomerPortalSession(input: BillingPortalSessionInput): Promise<BillingPortalSession> {
      void input;
      throw new BillingProviderUnconfiguredError();
    },

    verifyWebhook(input: WebhookVerificationInput): WebhookVerificationResult {
      void input;
      return { verified: false, reason: "provider_not_configured" };
    },

    parseWebhookEvent(rawBody: string): NormalizedBillingEvent | null {
      void rawBody;
      return null;
    },
  };
}
