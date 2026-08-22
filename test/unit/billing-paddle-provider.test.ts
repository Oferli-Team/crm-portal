import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@paddle/paddle-node-sdk";
import {
  createPaddleBillingProvider,
  PaddleAdapterError,
  PADDLE_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
} from "@/lib/billing/provider/paddle-provider";
import type { PaddleSdkClient } from "@/lib/billing/provider/paddle-client";
import type { PaddleProviderConfig } from "@/lib/billing/provider/paddle-config";

// src/lib/billing/provider/paddle-provider.ts (transitively, via
// paddle-client.ts) imports the real "server-only" marker package — see
// test/unit/billing-provider-availability.test.ts's own header comment
// for why this needs neutralizing here rather than disabling the guard
// globally.
vi.mock("server-only", () => ({}));

const ORG_ID = "11111111-1111-1111-1111-111111111111";

const CONFIG: PaddleProviderConfig = {
  environment: "sandbox",
  apiKey: "test-api-key",
  webhookSecret: "test-webhook-secret",
  priceIdByPlanKey: {
    STARTER: "pri_test_starter",
    PRO: "pri_test_pro",
  },
};

/** No network, no real SDK instance — every test injects this in place of a real Paddle client via createPaddleBillingProvider's own DI parameter. */
function fakeSdkClient(overrides: Partial<PaddleSdkClient> = {}): PaddleSdkClient {
  return {
    transactions: { create: vi.fn() },
    customerPortalSessions: { create: vi.fn() },
    ...overrides,
  } as PaddleSdkClient;
}

/** Builds a real `Paddle-Signature` header value the same way Paddle itself would — used to construct valid fixtures, and mutated field-by-field to construct invalid ones. */
function signPaddleWebhook(rawBody: string, secret: string, timestampSeconds: number, extraSignatures: string[] = []): string {
  const signature = createHmac("sha256", secret).update(`${timestampSeconds}:${rawBody}`).digest("hex");
  const h1Values = [signature, ...extraSignatures];
  return `ts=${timestampSeconds};${h1Values.map((value) => `h1=${value}`).join(";")}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

type SubscriptionEventDataOverrides = Record<string, unknown>;

/** A well-formed `subscription.*` webhook envelope, matching Paddle's own real, current payload shape (confirmed against developer.paddle.com's own quoted examples before writing this adapter) — every test overrides only the fields it's actually exercising. */
function subscriptionEventBody(eventType: string, dataOverrides: SubscriptionEventDataOverrides = {}, envelopeOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_id: "evt_01hxxx",
    event_type: eventType,
    occurred_at: "2026-01-15T10:00:00.000000Z",
    data: {
      id: "sub_01hxxx",
      customer_id: "ctm_01hxxx",
      status: "active",
      updated_at: "2026-01-15T10:00:00.000000Z",
      current_billing_period: { starts_at: "2026-01-15T10:00:00.000000Z", ends_at: "2026-02-15T10:00:00.000000Z" },
      scheduled_change: null,
      custom_data: { organizationId: ORG_ID },
      items: [{ price: { id: "pri_test_starter" }, trial_dates: null }],
      ...dataOverrides,
    },
    ...envelopeOverrides,
  });
}

describe("createPaddleBillingProvider", () => {
  it("reports kind: 'paddle' and name: 'PADDLE'", () => {
    const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());
    expect(provider.kind).toBe("paddle");
    expect(provider.name).toBe("PADDLE");
  });

  describe("createCheckoutSession", () => {
    it("resolves STARTER to its own configured price id", async () => {
      const create = vi.fn().mockResolvedValue({ id: "txn_1" });
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient({ transactions: { create } }));

      await provider.createCheckoutSession({
        organizationId: ORG_ID,
        planKey: "STARTER",
        returnUrl: "/settings/billing?checkout=success",
        cancelUrl: "/settings/billing?checkout=canceled",
        existingProviderCustomerId: null,
      });

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ items: [{ priceId: "pri_test_starter", quantity: 1 }] }),
      );
    });

    it("resolves PRO to its own, distinct configured price id", async () => {
      const create = vi.fn().mockResolvedValue({ id: "txn_2" });
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient({ transactions: { create } }));

      await provider.createCheckoutSession({
        organizationId: ORG_ID,
        planKey: "PRO",
        returnUrl: "/settings/billing?checkout=success",
        cancelUrl: "/settings/billing?checkout=canceled",
        existingProviderCustomerId: null,
      });

      expect(create).toHaveBeenCalledWith(expect.objectContaining({ items: [{ priceId: "pri_test_pro", quantity: 1 }] }));
    });

    it("always requests quantity: 1", async () => {
      const create = vi.fn().mockResolvedValue({ id: "txn_3" });
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient({ transactions: { create } }));

      await provider.createCheckoutSession({
        organizationId: ORG_ID,
        planKey: "STARTER",
        returnUrl: "/x",
        cancelUrl: "/y",
        existingProviderCustomerId: null,
      });

      const [request] = create.mock.calls[0];
      expect(request.items[0].quantity).toBe(1);
    });

    it("passes existingProviderCustomerId as customerId when present — reuses the existing provider customer, never creates a second one", async () => {
      const create = vi.fn().mockResolvedValue({ id: "txn_4" });
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient({ transactions: { create } }));

      await provider.createCheckoutSession({
        organizationId: ORG_ID,
        planKey: "STARTER",
        returnUrl: "/x",
        cancelUrl: "/y",
        existingProviderCustomerId: "ctm_existing_123",
      });

      expect(create).toHaveBeenCalledWith(expect.objectContaining({ customerId: "ctm_existing_123" }));
    });

    it("omits customerId entirely when existingProviderCustomerId is null — never sends null/undefined, lets Paddle resolve/create the customer itself", async () => {
      const create = vi.fn().mockResolvedValue({ id: "txn_5" });
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient({ transactions: { create } }));

      await provider.createCheckoutSession({
        organizationId: ORG_ID,
        planKey: "STARTER",
        returnUrl: "/x",
        cancelUrl: "/y",
        existingProviderCustomerId: null,
      });

      const [request] = create.mock.calls[0];
      expect(Object.prototype.hasOwnProperty.call(request, "customerId")).toBe(false);
    });

    it("embeds organizationId as customData, so a future webhook can recover which organization a delivered event is about", async () => {
      const create = vi.fn().mockResolvedValue({ id: "txn_6" });
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient({ transactions: { create } }));

      await provider.createCheckoutSession({
        organizationId: ORG_ID,
        planKey: "STARTER",
        returnUrl: "/x",
        cancelUrl: "/y",
        existingProviderCustomerId: null,
      });

      expect(create).toHaveBeenCalledWith(expect.objectContaining({ customData: { organizationId: ORG_ID } }));
    });

    it("returns this app's own /billing/checkout bridge URL, carrying the transaction id (E2.5 — never Paddle's own transaction.checkout.url)", async () => {
      const create = vi.fn().mockResolvedValue({ id: "txn_7", checkout: { url: "https://should-not-be-used.example/checkout" } });
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient({ transactions: { create } }));

      const session = await provider.createCheckoutSession({
        organizationId: ORG_ID,
        planKey: "STARTER",
        returnUrl: "/settings/billing?checkout=success",
        cancelUrl: "/settings/billing?checkout=canceled",
        existingProviderCustomerId: null,
      });

      const url = new URL(session.url);
      expect(url.pathname).toBe("/billing/checkout");
      expect(url.hostname).not.toBe("should-not-be-used.example");
      expect(url.searchParams.get("transactionId")).toBe("txn_7");
    });

    it("embeds this adapter's own configured environment (sandbox/live) on the bridge URL, so the browser knows which Paddle environment to initialize", async () => {
      const create = vi.fn().mockResolvedValue({ id: "txn_8" });
      const sandboxProvider = createPaddleBillingProvider(CONFIG, fakeSdkClient({ transactions: { create } }));
      const liveProvider = createPaddleBillingProvider(
        { ...CONFIG, environment: "live" },
        fakeSdkClient({ transactions: { create } }),
      );

      const sandboxSession = await sandboxProvider.createCheckoutSession({
        organizationId: ORG_ID,
        planKey: "STARTER",
        returnUrl: "/x",
        cancelUrl: "/y",
        existingProviderCustomerId: null,
      });
      const liveSession = await liveProvider.createCheckoutSession({
        organizationId: ORG_ID,
        planKey: "STARTER",
        returnUrl: "/x",
        cancelUrl: "/y",
        existingProviderCustomerId: null,
      });

      expect(new URL(sandboxSession.url).searchParams.get("environment")).toBe("sandbox");
      expect(new URL(liveSession.url).searchParams.get("environment")).toBe("live");
    });

    it("carries returnUrl/cancelUrl through to the bridge URL, so the checkout bridge page can send the browser back to the right place", async () => {
      const create = vi.fn().mockResolvedValue({ id: "txn_9" });
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient({ transactions: { create } }));

      const session = await provider.createCheckoutSession({
        organizationId: ORG_ID,
        planKey: "STARTER",
        returnUrl: "/settings/billing?checkout=success",
        cancelUrl: "/settings/billing?checkout=canceled",
        existingProviderCustomerId: null,
      });

      const url = new URL(session.url);
      expect(url.searchParams.get("returnUrl")).toBe("/settings/billing?checkout=success");
      expect(url.searchParams.get("cancelUrl")).toBe("/settings/billing?checkout=canceled");
    });

    it("builds the bridge URL against APP_BASE_URL when set", async () => {
      const previous = process.env.APP_BASE_URL;
      process.env.APP_BASE_URL = "https://buyer-app.example.org/";
      try {
        const create = vi.fn().mockResolvedValue({ id: "txn_10" });
        const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient({ transactions: { create } }));

        const session = await provider.createCheckoutSession({
          organizationId: ORG_ID,
          planKey: "STARTER",
          returnUrl: "/x",
          cancelUrl: "/y",
          existingProviderCustomerId: null,
        });

        expect(session.url.startsWith("https://buyer-app.example.org/billing/checkout")).toBe(true);
      } finally {
        if (previous === undefined) delete process.env.APP_BASE_URL;
        else process.env.APP_BASE_URL = previous;
      }
    });

    it("never leaks the API key or webhook secret into the bridge URL", async () => {
      const create = vi.fn().mockResolvedValue({ id: "txn_11" });
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient({ transactions: { create } }));

      const session = await provider.createCheckoutSession({
        organizationId: ORG_ID,
        planKey: "STARTER",
        returnUrl: "/x",
        cancelUrl: "/y",
        existingProviderCustomerId: null,
      });

      expect(session.url).not.toContain(CONFIG.apiKey);
      expect(session.url).not.toContain(CONFIG.webhookSecret);
    });

    it("fails closed with a controlled error when the plan key has no configured price id", async () => {
      const create = vi.fn();
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient({ transactions: { create } }));

      await expect(
        provider.createCheckoutSession({
          organizationId: ORG_ID,
          planKey: "LEGACY",
          returnUrl: "/x",
          cancelUrl: "/y",
          existingProviderCustomerId: null,
        }),
      ).rejects.toThrow(PaddleAdapterError);
      expect(create).not.toHaveBeenCalled();
    });

    it("fails closed with a controlled error, never the raw SDK error, when the SDK call throws", async () => {
      const sdkError = new ApiError({ type: "request_error", code: "not_found", detail: "not found", documentation_url: "" }, null);
      const create = vi.fn().mockRejectedValue(sdkError);
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient({ transactions: { create } }));

      let caught: unknown;
      try {
        await provider.createCheckoutSession({
          organizationId: ORG_ID,
          planKey: "STARTER",
          returnUrl: "/x",
          cancelUrl: "/y",
          existingProviderCustomerId: null,
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PaddleAdapterError);
      expect((caught as PaddleAdapterError).code).toBe("not_found");
      expect((caught as PaddleAdapterError).message).not.toContain("test-api-key");
      expect(JSON.stringify(caught)).not.toContain("test-api-key");
    });
  });

  describe("createCustomerPortalSession", () => {
    it("passes providerCustomerId through to the SDK call", async () => {
      const create = vi.fn().mockResolvedValue({ urls: { general: { overview: "https://portal.paddle.com/abc" } } });
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient({ customerPortalSessions: { create } }));

      await provider.createCustomerPortalSession({
        organizationId: ORG_ID,
        providerCustomerId: "ctm_abc123",
        returnUrl: "/settings/billing",
      });

      expect(create).toHaveBeenCalledWith("ctm_abc123", []);
    });

    it("returns the hosted customer portal URL", async () => {
      const create = vi.fn().mockResolvedValue({ urls: { general: { overview: "https://portal.paddle.com/xyz" } } });
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient({ customerPortalSessions: { create } }));

      const session = await provider.createCustomerPortalSession({
        organizationId: ORG_ID,
        providerCustomerId: "ctm_abc123",
        returnUrl: "/settings/billing",
      });

      expect(session).toEqual({ url: "https://portal.paddle.com/xyz" });
    });

    it("fails closed with a controlled error when Paddle returns no overview URL", async () => {
      const create = vi.fn().mockResolvedValue({ urls: { general: { overview: "" } } });
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient({ customerPortalSessions: { create } }));

      await expect(
        provider.createCustomerPortalSession({
          organizationId: ORG_ID,
          providerCustomerId: "ctm_abc123",
          returnUrl: "/settings/billing",
        }),
      ).rejects.toThrow(PaddleAdapterError);
    });

    it("fails closed with a controlled error, never the raw SDK error, when the SDK call throws", async () => {
      const sdkError = new ApiError({ type: "request_error", code: "not_found", detail: "not found", documentation_url: "" }, null);
      const create = vi.fn().mockRejectedValue(sdkError);
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient({ customerPortalSessions: { create } }));

      let caught: unknown;
      try {
        await provider.createCustomerPortalSession({
          organizationId: ORG_ID,
          providerCustomerId: "ctm_abc123",
          returnUrl: "/settings/billing",
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PaddleAdapterError);
      expect((caught as PaddleAdapterError).code).toBe("not_found");
      expect((caught as PaddleAdapterError).message).not.toContain("test-webhook-secret");
    });
  });

  describe("verifyWebhook (E2.4 — real Paddle-Signature HMAC-SHA256 verification)", () => {
    const rawBody = subscriptionEventBody("subscription.created");

    it("verifies a correctly signed payload", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());
      const ts = nowSeconds();
      const headers = new Headers({ "Paddle-Signature": signPaddleWebhook(rawBody, CONFIG.webhookSecret, ts) });

      expect(provider.verifyWebhook({ rawBody, headers })).toEqual({ verified: true });
    });

    it("reads the signature header case-insensitively via the Headers API", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());
      const ts = nowSeconds();
      const headers = new Headers({ "paddle-signature": signPaddleWebhook(rawBody, CONFIG.webhookSecret, ts) });

      expect(provider.verifyWebhook({ rawBody, headers })).toEqual({ verified: true });
    });

    it("fails closed, without throwing, when the signature header is missing", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

      const result = provider.verifyWebhook({ rawBody, headers: new Headers() });

      expect(result).toEqual({ verified: false, reason: "missing_signature_header" });
    });

    it("fails closed when the signature header is malformed (no recognizable ts/h1 pairs)", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());
      const headers = new Headers({ "Paddle-Signature": "not-a-valid-header" });

      const result = provider.verifyWebhook({ rawBody, headers });

      expect(result).toEqual({ verified: false, reason: "malformed_signature_header" });
    });

    it("fails closed when the header has a ts but no h1", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());
      const headers = new Headers({ "Paddle-Signature": `ts=${nowSeconds()}` });

      const result = provider.verifyWebhook({ rawBody, headers });

      expect(result).toEqual({ verified: false, reason: "malformed_signature_header" });
    });

    it("fails closed when the header has an h1 but no ts", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());
      const headers = new Headers({ "Paddle-Signature": "h1=deadbeef" });

      const result = provider.verifyWebhook({ rawBody, headers });

      expect(result).toEqual({ verified: false, reason: "malformed_signature_header" });
    });

    it("accepts a match against any h1 value when multiple are present (Paddle's own secret-rotation format)", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());
      const ts = nowSeconds();
      const header = signPaddleWebhook(rawBody, CONFIG.webhookSecret, ts, ["0000000000000000000000000000000000000000000000000000000000000000"]);
      const headers = new Headers({ "Paddle-Signature": header });

      expect(provider.verifyWebhook({ rawBody, headers })).toEqual({ verified: true });
    });

    it("fails closed when the signature was computed with a different secret", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());
      const ts = nowSeconds();
      const headers = new Headers({ "Paddle-Signature": signPaddleWebhook(rawBody, "wrong-secret", ts) });

      const result = provider.verifyWebhook({ rawBody, headers });

      expect(result).toEqual({ verified: false, reason: "signature_mismatch" });
    });

    it("fails closed when the raw body is mutated after signing (tamper detection)", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());
      const ts = nowSeconds();
      const headers = new Headers({ "Paddle-Signature": signPaddleWebhook(rawBody, CONFIG.webhookSecret, ts) });
      const tamperedBody = rawBody.replace("subscription.created", "subscription.canceled");

      const result = provider.verifyWebhook({ rawBody: tamperedBody, headers });

      expect(result).toEqual({ verified: false, reason: "signature_mismatch" });
    });

    it(`fails closed when the timestamp is older than the documented ${PADDLE_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS}-second tolerance`, () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());
      const ts = nowSeconds() - PADDLE_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS - 30;
      const headers = new Headers({ "Paddle-Signature": signPaddleWebhook(rawBody, CONFIG.webhookSecret, ts) });

      const result = provider.verifyWebhook({ rawBody, headers });

      expect(result).toEqual({ verified: false, reason: "timestamp_too_old" });
    });

    it("verifies a timestamp within the documented tolerance", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());
      const ts = nowSeconds() - (PADDLE_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS - 1);
      const headers = new Headers({ "Paddle-Signature": signPaddleWebhook(rawBody, CONFIG.webhookSecret, ts) });

      expect(provider.verifyWebhook({ rawBody, headers })).toEqual({ verified: true });
    });

    it("fails closed when the ts value is not a number", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());
      const headers = new Headers({ "Paddle-Signature": "ts=not-a-number;h1=deadbeef" });

      const result = provider.verifyWebhook({ rawBody, headers });

      expect(result).toEqual({ verified: false, reason: "malformed_timestamp" });
    });

    it("never throws for a normal invalid signature", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());
      const headers = new Headers({ "Paddle-Signature": "ts=123;h1=deadbeef" });

      expect(() => provider.verifyWebhook({ rawBody, headers })).not.toThrow();
    });
  });

  describe("parseWebhookEvent (E2.4 — real event normalization)", () => {
    it("normalizes subscription.created", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

      const event = provider.parseWebhookEvent(subscriptionEventBody("subscription.created"));

      expect(event).toMatchObject({
        type: "SUBSCRIPTION_CREATED",
        providerEventId: "evt_01hxxx",
        providerCustomerId: "ctm_01hxxx",
        providerSubscriptionId: "sub_01hxxx",
        organizationId: ORG_ID,
        planKey: "STARTER",
        status: "ACTIVE",
        cancelAtPeriodEnd: false,
      });
      expect(event?.currentPeriodStart).toEqual(new Date("2026-01-15T10:00:00.000000Z"));
      expect(event?.currentPeriodEnd).toEqual(new Date("2026-02-15T10:00:00.000000Z"));
    });

    it("normalizes subscription.activated", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

      const event = provider.parseWebhookEvent(subscriptionEventBody("subscription.activated"));

      expect(event?.type).toBe("SUBSCRIPTION_ACTIVATED");
    });

    it("normalizes subscription.updated", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

      const event = provider.parseWebhookEvent(subscriptionEventBody("subscription.updated"));

      expect(event?.type).toBe("SUBSCRIPTION_UPDATED");
    });

    it("normalizes subscription.canceled", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

      const event = provider.parseWebhookEvent(
        subscriptionEventBody("subscription.canceled", { status: "canceled", current_billing_period: null }),
      );

      expect(event?.type).toBe("SUBSCRIPTION_CANCELED");
      expect(event?.status).toBe("CANCELED");
      expect(event?.currentPeriodStart).toBeNull();
      expect(event?.currentPeriodEnd).toBeNull();
    });

    it("normalizes subscription.past_due", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

      const event = provider.parseWebhookEvent(subscriptionEventBody("subscription.past_due", { status: "past_due" }));

      expect(event?.type).toBe("SUBSCRIPTION_PAST_DUE");
      expect(event?.status).toBe("PAST_DUE");
    });

    it("maps a plan change (subscription.updated with the PRO price) to planKey PRO", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

      const event = provider.parseWebhookEvent(
        subscriptionEventBody("subscription.updated", { items: [{ price: { id: "pri_test_pro" }, trial_dates: null }] }),
      );

      expect(event?.planKey).toBe("PRO");
    });

    it("derives cancelAtPeriodEnd: true from scheduled_change.action === 'cancel' on subscription.updated", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

      const event = provider.parseWebhookEvent(
        subscriptionEventBody("subscription.updated", {
          scheduled_change: { action: "cancel", effective_at: "2026-02-15T10:00:00.000000Z", resume_at: null },
        }),
      );

      expect(event?.cancelAtPeriodEnd).toBe(true);
    });

    it("recognizes a known STARTER price id", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

      const event = provider.parseWebhookEvent(
        subscriptionEventBody("subscription.created", { items: [{ price: { id: "pri_test_starter" }, trial_dates: null }] }),
      );

      expect(event?.planKey).toBe("STARTER");
    });

    it("recognizes a known PRO price id", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

      const event = provider.parseWebhookEvent(
        subscriptionEventBody("subscription.created", { items: [{ price: { id: "pri_test_pro" }, trial_dates: null }] }),
      );

      expect(event?.planKey).toBe("PRO");
    });

    it("maps an unknown/unconfigured price id to planKey: null, never throwing", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

      const event = provider.parseWebhookEvent(
        subscriptionEventBody("subscription.created", { items: [{ price: { id: "pri_unknown_price" }, trial_dates: null }] }),
      );

      expect(event?.planKey).toBeNull();
    });

    it("maps a missing custom_data to organizationId: null rather than throwing or fabricating one", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

      const event = provider.parseWebhookEvent(subscriptionEventBody("subscription.created", { custom_data: null }));

      expect(event?.organizationId).toBeNull();
    });

    it("falls back to the event's own occurred_at for providerUpdatedAt when updated_at is malformed", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

      const event = provider.parseWebhookEvent(subscriptionEventBody("subscription.created", { updated_at: "not-a-date" }));

      expect(event?.providerUpdatedAt).toEqual(new Date("2026-01-15T10:00:00.000000Z"));
    });

    it("returns EVENT_IGNORED (a successful parse, not null) for an unrecognized subscription event type", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

      const event = provider.parseWebhookEvent(subscriptionEventBody("subscription.some_future_event"));

      expect(event).toMatchObject({ type: "EVENT_IGNORED", providerEventId: "evt_01hxxx" });
    });

    it("returns EVENT_IGNORED for a non-subscription event category (e.g. transaction.completed) rather than acting on it", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

      const event = provider.parseWebhookEvent(subscriptionEventBody("transaction.completed"));

      expect(event).toMatchObject({ type: "EVENT_IGNORED" });
    });

    it("returns null for a payload that isn't valid JSON", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

      expect(provider.parseWebhookEvent("not json")).toBeNull();
    });

    it("returns null when required envelope fields (event_id/event_type/occurred_at) are missing", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

      expect(provider.parseWebhookEvent(JSON.stringify({ data: {} }))).toBeNull();
    });

    it("returns null when a subscription.* event has no data object at all", () => {
      const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

      const body = JSON.stringify({ event_id: "evt_1", event_type: "subscription.created", occurred_at: "2026-01-15T10:00:00.000000Z" });

      expect(provider.parseWebhookEvent(body)).toBeNull();
    });

    describe("edge lifecycle states", () => {
      it("ignores subscription.paused (this app's schema has no PAUSED status)", () => {
        const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

        const event = provider.parseWebhookEvent(subscriptionEventBody("subscription.paused", { status: "paused" }));

        expect(event).toMatchObject({ type: "EVENT_IGNORED" });
      });

      it("ignores a status: 'paused' payload even when it arrives via subscription.updated", () => {
        const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

        const event = provider.parseWebhookEvent(subscriptionEventBody("subscription.updated", { status: "paused" }));

        expect(event).toMatchObject({ type: "EVENT_IGNORED" });
      });

      it("maps subscription.resumed to SUBSCRIPTION_UPDATED", () => {
        const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

        const event = provider.parseWebhookEvent(subscriptionEventBody("subscription.resumed"));

        expect(event?.type).toBe("SUBSCRIPTION_UPDATED");
      });

      it("maps subscription.trialing to SUBSCRIPTION_UPDATED with status TRIALING", () => {
        const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

        const event = provider.parseWebhookEvent(subscriptionEventBody("subscription.trialing", { status: "trialing" }));

        expect(event?.type).toBe("SUBSCRIPTION_UPDATED");
        expect(event?.status).toBe("TRIALING");
      });

      it("ignores subscription.imported", () => {
        const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

        const event = provider.parseWebhookEvent(subscriptionEventBody("subscription.imported"));

        expect(event).toMatchObject({ type: "EVENT_IGNORED" });
      });

      it("maps a status this app has no equivalent for (Paddle has no 'unpaid' status) to status: null rather than fabricating one", () => {
        const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

        const event = provider.parseWebhookEvent(subscriptionEventBody("subscription.updated", { status: "unpaid" }));

        expect(event?.status).toBeNull();
      });
    });

    describe("trust boundary", () => {
      it("does not throw or reject when organizationId claims an organization this test never validates — parseWebhookEvent performs no DB lookups", () => {
        const provider = createPaddleBillingProvider(CONFIG, fakeSdkClient());

        const event = provider.parseWebhookEvent(
          subscriptionEventBody("subscription.created", { custom_data: { organizationId: "not-a-real-org-id" } }),
        );

        expect(event?.organizationId).toBe("not-a-real-org-id");
      });
    });
  });

  describe("security", () => {
    it("never logs the api key or webhook secret across the full checkout + portal + webhook surface, including a real signed payload", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const create = vi.fn().mockResolvedValue({ id: "txn_8" });
      const portalCreate = vi.fn().mockResolvedValue({ urls: { general: { overview: "https://portal.paddle.com/abc" } } });
      const provider = createPaddleBillingProvider(
        CONFIG,
        fakeSdkClient({ transactions: { create }, customerPortalSessions: { create: portalCreate } }),
      );

      await provider.createCheckoutSession({
        organizationId: ORG_ID,
        planKey: "STARTER",
        returnUrl: "/x",
        cancelUrl: "/y",
        existingProviderCustomerId: null,
      });
      await provider.createCustomerPortalSession({
        organizationId: ORG_ID,
        providerCustomerId: "ctm_abc123",
        returnUrl: "/settings/billing",
      });

      const rawBody = subscriptionEventBody("subscription.created");
      const validHeaders = new Headers({ "Paddle-Signature": signPaddleWebhook(rawBody, CONFIG.webhookSecret, nowSeconds()) });
      provider.verifyWebhook({ rawBody, headers: validHeaders });
      provider.verifyWebhook({ rawBody, headers: new Headers() });
      provider.parseWebhookEvent(rawBody);

      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();

      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("makes no real network call — every SDK method used in these tests is this file's own fake, never the real @paddle/paddle-node-sdk client", async () => {
      const create = vi.fn().mockResolvedValue({ id: "txn_9" });
      const client = fakeSdkClient({ transactions: { create } });
      const provider = createPaddleBillingProvider(CONFIG, client);

      await provider.createCheckoutSession({
        organizationId: ORG_ID,
        planKey: "STARTER",
        returnUrl: "/x",
        cancelUrl: "/y",
        existingProviderCustomerId: null,
      });

      expect(create).toHaveBeenCalledTimes(1);
    });
  });
});
