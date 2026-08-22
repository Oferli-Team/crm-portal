import "server-only";
import crypto from "node:crypto";
import { TEST_MODE } from "@/lib/test-mode";
import type { SubscriptionStatus } from "@/generated/prisma/enums";
import type {
  BillingProviderAdapter,
  BillingCheckoutSessionInput,
  BillingCheckoutSession,
  BillingPortalSessionInput,
  BillingPortalSession,
  WebhookVerificationInput,
  WebhookVerificationResult,
  NormalizedBillingEvent,
  BillingProviderEventType,
} from "./types";

/**
 * Billing & Subscriptions Stage 4 (this stage's own §4/§14). A full,
 * deterministic, TEST_MODE-only stand-in for a real Paddle/Stripe adapter
 * — makes zero network calls, stores no card/payment data anywhere (there
 * is none to store: the mock never collects a card number, email, or
 * billing address in the first place), and every id it produces is
 * derived deterministically from its input rather than randomly, so an
 * E2E/integration test can assert on it without first capturing a
 * generated value.
 *
 * `createMockBillingProvider` itself throws outside TEST_MODE — a second,
 * independent gate behind the registry's own TEST_MODE check
 * (src/lib/billing/provider/provider.ts), so this file can never
 * accidentally become reachable in a real deployment even if the registry
 * itself were ever miswired.
 */

const MOCK_PERIOD_DAYS = 30;

// A fixed, TEST_MODE-only constant — never a real secret, never read from
// an env var, and (per the throw below) never reachable when TEST_MODE is
// off. Exists so this adapter's own verifyWebhook exercises a genuine
// HMAC computation end to end (the same contract a real adapter's
// verifyWebhook would use against a real provider secret), rather than a
// stubbed-out always-true check.
const MOCK_WEBHOOK_SECRET = "test-mode-mock-billing-webhook-secret";

export const MOCK_WEBHOOK_SIGNATURE_HEADER = "x-mock-billing-signature";

export function signMockWebhookPayload(rawBody: string): string {
  return crypto.createHmac("sha256", MOCK_WEBHOOK_SECRET).update(rawBody).digest("hex");
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Deterministic — the same organization always maps to the same mock provider customer id, so "reuse an existing customer" is trivially exercisable in tests without persisting anything here. */
export function deriveMockCustomerId(organizationId: string): string {
  return `mock_cus_${organizationId}`;
}

export function deriveMockSubscriptionId(organizationId: string): string {
  return `mock_sub_${organizationId}`;
}

/**
 * The mock adapter's own minimal wire format — deliberately not an
 * attempt to byte-for-byte replicate a real Paddle/Stripe payload shape
 * (there is no real payload to replicate against). Its only job is to
 * prove the full pipeline (sign → POST → verify → parse → map → apply)
 * runs for real, the same shape a genuine provider payload would take
 * through this exact same seam.
 */
type MockWebhookPayload = {
  id: string;
  type: BillingProviderEventType;
  createdAt: string;
  data: {
    customerId: string | null;
    subscriptionId: string | null;
    organizationId: string | null;
    planKey: string | null;
    status: SubscriptionStatus | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean | null;
    trialEnd: string | null;
    updatedAt: string;
  };
};

export type MockWebhookEventInput = {
  eventType: BillingProviderEventType;
  /** Nullable so tests can construct a "provider echoed back no org claim at all" event — see event-mapper.ts's REJECT_MISSING_ORGANIZATION case. */
  organizationId: string | null;
  providerCustomerId: string;
  providerSubscriptionId: string;
  planKey: string;
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: Date | null;
  now: Date;
  /** A stable, caller-supplied idempotency key — lets a test fire the exact same event twice and assert on duplicate-handling deterministically, rather than a fresh random id defeating that on purpose. */
  providerEventId: string;
};

/**
 * Builds and signs one mock webhook request — the single function every
 * mock checkout/portal Server Action (src/app/billing/mock/*) calls to
 * produce exactly what to POST to the real `/api/billing/webhook` route.
 * Never touches the database itself and never calls that route directly
 * (the caller does, over a real HTTP request) — this only builds the
 * signed envelope.
 */
export function buildMockWebhookRequest(input: MockWebhookEventInput): { rawBody: string; signatureHeader: string } {
  const payload: MockWebhookPayload = {
    id: input.providerEventId,
    type: input.eventType,
    createdAt: input.now.toISOString(),
    data: {
      customerId: input.providerCustomerId,
      subscriptionId: input.providerSubscriptionId,
      organizationId: input.organizationId,
      planKey: input.planKey,
      status: input.status,
      currentPeriodStart: input.currentPeriodStart ? input.currentPeriodStart.toISOString() : null,
      currentPeriodEnd: input.currentPeriodEnd ? input.currentPeriodEnd.toISOString() : null,
      cancelAtPeriodEnd: input.cancelAtPeriodEnd,
      trialEnd: input.trialEnd ? input.trialEnd.toISOString() : null,
      updatedAt: input.now.toISOString(),
    },
  };
  const rawBody = JSON.stringify(payload);
  return { rawBody, signatureHeader: signMockWebhookPayload(rawBody) };
}

/** A brand-new mock checkout's default period — 30 days from "now," the same fixed cadence for every mock plan (there is no real price/billing-interval concept to model here). */
export function mockPeriodEnd(now: Date): Date {
  return new Date(now.getTime() + MOCK_PERIOD_DAYS * 24 * 60 * 60 * 1000);
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function createMockBillingProvider(): BillingProviderAdapter {
  if (!TEST_MODE) {
    // Mirrors src/lib/storage/test-storage.ts's own "the fake is
    // unreachable outside TEST_MODE, full stop" discipline — this should
    // be unreachable already via the registry's own check, but a second,
    // independent gate here means a future refactor of the registry can
    // never silently make the mock reachable in production.
    throw new Error("MockBillingProvider is only available in TEST_MODE.");
  }

  return {
    kind: "mock",
    name: "PADDLE",

    async createCheckoutSession(input: BillingCheckoutSessionInput): Promise<BillingCheckoutSession> {
      const customerId = input.existingProviderCustomerId ?? deriveMockCustomerId(input.organizationId);
      const params = new URLSearchParams({
        organizationId: input.organizationId,
        planKey: input.planKey,
        returnUrl: input.returnUrl,
        cancelUrl: input.cancelUrl,
        customerId,
      });
      return { url: `/billing/mock/checkout?${params.toString()}` };
    },

    async createCustomerPortalSession(input: BillingPortalSessionInput): Promise<BillingPortalSession> {
      const params = new URLSearchParams({
        organizationId: input.organizationId,
        customerId: input.providerCustomerId,
        returnUrl: input.returnUrl,
      });
      return { url: `/billing/mock/portal?${params.toString()}` };
    },

    verifyWebhook(input: WebhookVerificationInput): WebhookVerificationResult {
      const signatureHeader = input.headers.get(MOCK_WEBHOOK_SIGNATURE_HEADER);
      if (!signatureHeader) {
        return { verified: false, reason: "missing_signature" };
      }
      const expected = signMockWebhookPayload(input.rawBody);
      if (!timingSafeEqualStrings(expected, signatureHeader)) {
        return { verified: false, reason: "signature_mismatch" };
      }
      return { verified: true };
    },

    parseWebhookEvent(rawBody: string): NormalizedBillingEvent | null {
      let payload: MockWebhookPayload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return null;
      }
      if (typeof payload?.id !== "string" || typeof payload?.type !== "string" || !payload.data) {
        return null;
      }
      const createdAt = parseDate(payload.createdAt);
      const updatedAt = parseDate(payload.data.updatedAt);
      if (!createdAt || !updatedAt) {
        return null;
      }

      return {
        type: payload.type,
        providerEventId: payload.id,
        providerCreatedAt: createdAt,
        providerCustomerId: payload.data.customerId ?? null,
        providerSubscriptionId: payload.data.subscriptionId ?? null,
        organizationId: payload.data.organizationId ?? null,
        planKey: payload.data.planKey ?? null,
        status: payload.data.status ?? null,
        currentPeriodStart: parseDate(payload.data.currentPeriodStart),
        currentPeriodEnd: parseDate(payload.data.currentPeriodEnd),
        cancelAtPeriodEnd: payload.data.cancelAtPeriodEnd ?? null,
        trialEnd: parseDate(payload.data.trialEnd),
        providerUpdatedAt: updatedAt,
      };
    },
  };
}
