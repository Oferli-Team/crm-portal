import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// src/lib/billing/provider/mock-provider.ts imports the real "server-only"
// marker package — see test/unit/cron-auth.test.ts's own header comment.
vi.mock("server-only", () => ({}));

async function importFresh() {
  vi.resetModules();
  return import("@/lib/billing/provider/mock-provider");
}

const NOW = new Date("2026-06-15T12:00:00.000Z");
const ORG_ID = "11111111-1111-1111-1111-111111111111";

describe("createMockBillingProvider outside TEST_MODE", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("throws at construction — a second, independent gate behind the registry's own TEST_MODE check", async () => {
    vi.stubEnv("TEST_MODE", "");
    const { createMockBillingProvider } = await importFresh();
    expect(() => createMockBillingProvider()).toThrow(/TEST_MODE/);
  });
});

describe("createMockBillingProvider under TEST_MODE", () => {
  beforeEach(() => vi.stubEnv("TEST_MODE", "1"));
  afterEach(() => vi.unstubAllEnvs());

  it("reports kind: 'mock'", async () => {
    const { createMockBillingProvider } = await importFresh();
    expect(createMockBillingProvider().kind).toBe("mock");
  });

  it("createCheckoutSession derives a deterministic customer id when none exists yet", async () => {
    const { createMockBillingProvider, deriveMockCustomerId } = await importFresh();
    const provider = createMockBillingProvider();
    const session = await provider.createCheckoutSession({
      organizationId: ORG_ID,
      planKey: "STARTER",
      returnUrl: "/settings/billing?checkout=success",
      cancelUrl: "/settings/billing?checkout=cancel",
      existingProviderCustomerId: null,
    });
    expect(session.url).toContain("/billing/mock/checkout");
    expect(session.url).toContain(`customerId=${deriveMockCustomerId(ORG_ID)}`);
    expect(session.url).toContain(`organizationId=${ORG_ID}`);
  });

  it("createCheckoutSession reuses an existing provider customer id instead of deriving a new one", async () => {
    const { createMockBillingProvider } = await importFresh();
    const provider = createMockBillingProvider();
    const session = await provider.createCheckoutSession({
      organizationId: ORG_ID,
      planKey: "PRO",
      returnUrl: "/settings/billing",
      cancelUrl: "/settings/billing",
      existingProviderCustomerId: "cus_existing_123",
    });
    expect(session.url).toContain("customerId=cus_existing_123");
  });

  it("createCustomerPortalSession returns a same-origin mock portal path", async () => {
    const { createMockBillingProvider } = await importFresh();
    const provider = createMockBillingProvider();
    const session = await provider.createCustomerPortalSession({
      organizationId: ORG_ID,
      providerCustomerId: "cus_existing_123",
      returnUrl: "/settings/billing",
    });
    expect(session.url).toContain("/billing/mock/portal");
    expect(session.url).toContain("customerId=cus_existing_123");
  });

  it("deriveMockCustomerId/deriveMockSubscriptionId are deterministic — same org, same id every time", async () => {
    const { deriveMockCustomerId, deriveMockSubscriptionId } = await importFresh();
    expect(deriveMockCustomerId(ORG_ID)).toBe(deriveMockCustomerId(ORG_ID));
    expect(deriveMockSubscriptionId(ORG_ID)).toBe(deriveMockSubscriptionId(ORG_ID));
    expect(deriveMockCustomerId(ORG_ID)).not.toBe(deriveMockSubscriptionId(ORG_ID));
  });

  describe("signature verification", () => {
    it("verifies a correctly-signed payload", async () => {
      const { createMockBillingProvider, signMockWebhookPayload, MOCK_WEBHOOK_SIGNATURE_HEADER } = await importFresh();
      const provider = createMockBillingProvider();
      const rawBody = JSON.stringify({ hello: "world" });
      const signature = signMockWebhookPayload(rawBody);
      const headers = new Headers({ [MOCK_WEBHOOK_SIGNATURE_HEADER]: signature });
      expect(provider.verifyWebhook({ rawBody, headers })).toEqual({ verified: true });
    });

    it("rejects a missing signature header", async () => {
      const { createMockBillingProvider } = await importFresh();
      const provider = createMockBillingProvider();
      const result = provider.verifyWebhook({ rawBody: "{}", headers: new Headers() });
      expect(result.verified).toBe(false);
    });

    it("rejects a tampered payload (signature no longer matches)", async () => {
      const { createMockBillingProvider, signMockWebhookPayload, MOCK_WEBHOOK_SIGNATURE_HEADER } = await importFresh();
      const provider = createMockBillingProvider();
      const signature = signMockWebhookPayload(JSON.stringify({ hello: "world" }));
      const tamperedBody = JSON.stringify({ hello: "tampered" });
      const headers = new Headers({ [MOCK_WEBHOOK_SIGNATURE_HEADER]: signature });
      expect(provider.verifyWebhook({ rawBody: tamperedBody, headers }).verified).toBe(false);
    });

    it("rejects a signature of the wrong length without throwing (timing-safe comparison guard)", async () => {
      const { createMockBillingProvider, MOCK_WEBHOOK_SIGNATURE_HEADER } = await importFresh();
      const provider = createMockBillingProvider();
      const headers = new Headers({ [MOCK_WEBHOOK_SIGNATURE_HEADER]: "short" });
      expect(() => provider.verifyWebhook({ rawBody: "{}", headers })).not.toThrow();
      expect(provider.verifyWebhook({ rawBody: "{}", headers }).verified).toBe(false);
    });
  });

  describe("buildMockWebhookRequest / parseWebhookEvent round-trip", () => {
    it("normalizes every field correctly", async () => {
      const { createMockBillingProvider, buildMockWebhookRequest, MOCK_WEBHOOK_SIGNATURE_HEADER } = await importFresh();
      const provider = createMockBillingProvider();

      const { rawBody, signatureHeader } = buildMockWebhookRequest({
        eventType: "SUBSCRIPTION_ACTIVATED",
        organizationId: ORG_ID,
        providerCustomerId: "cus_1",
        providerSubscriptionId: "sub_1",
        planKey: "STARTER",
        status: "ACTIVE",
        currentPeriodStart: NOW,
        currentPeriodEnd: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000),
        cancelAtPeriodEnd: false,
        trialEnd: null,
        now: NOW,
        providerEventId: "evt_abc",
      });

      const verification = provider.verifyWebhook({ rawBody, headers: new Headers({ [MOCK_WEBHOOK_SIGNATURE_HEADER]: signatureHeader }) });
      expect(verification.verified).toBe(true);

      const parsed = provider.parseWebhookEvent(rawBody);
      expect(parsed).not.toBeNull();
      expect(parsed).toMatchObject({
        type: "SUBSCRIPTION_ACTIVATED",
        providerEventId: "evt_abc",
        providerCustomerId: "cus_1",
        providerSubscriptionId: "sub_1",
        organizationId: ORG_ID,
        planKey: "STARTER",
        status: "ACTIVE",
        cancelAtPeriodEnd: false,
      });
      expect(parsed!.providerCreatedAt).toBeInstanceOf(Date);
      expect(parsed!.providerUpdatedAt).toBeInstanceOf(Date);
    });

    it("never carries a raw payload field beyond the normalized shape — no extra keys leak through", async () => {
      const { buildMockWebhookRequest, createMockBillingProvider } = await importFresh();
      const provider = createMockBillingProvider();
      const { rawBody } = buildMockWebhookRequest({
        eventType: "SUBSCRIPTION_UPDATED",
        organizationId: ORG_ID,
        providerCustomerId: "cus_1",
        providerSubscriptionId: "sub_1",
        planKey: "PRO",
        status: "ACTIVE",
        currentPeriodStart: NOW,
        currentPeriodEnd: NOW,
        cancelAtPeriodEnd: false,
        trialEnd: null,
        now: NOW,
        providerEventId: "evt_xyz",
      });
      const parsed = provider.parseWebhookEvent(rawBody);
      expect(Object.keys(parsed!).sort()).toEqual(
        [
          "type",
          "providerEventId",
          "providerCreatedAt",
          "providerCustomerId",
          "providerSubscriptionId",
          "organizationId",
          "planKey",
          "status",
          "currentPeriodStart",
          "currentPeriodEnd",
          "cancelAtPeriodEnd",
          "trialEnd",
          "providerUpdatedAt",
        ].sort(),
      );
    });
  });

  describe("parseWebhookEvent — malformed input", () => {
    it("returns null for invalid JSON", async () => {
      const { createMockBillingProvider } = await importFresh();
      expect(createMockBillingProvider().parseWebhookEvent("not json")).toBeNull();
    });

    it("returns null when required fields (id/type/data) are missing", async () => {
      const { createMockBillingProvider } = await importFresh();
      expect(createMockBillingProvider().parseWebhookEvent(JSON.stringify({ foo: "bar" }))).toBeNull();
    });

    it("returns null when timestamps are unparseable", async () => {
      const { createMockBillingProvider } = await importFresh();
      const badPayload = JSON.stringify({
        id: "evt_1",
        type: "SUBSCRIPTION_UPDATED",
        createdAt: "not-a-date",
        data: { updatedAt: "also-not-a-date" },
      });
      expect(createMockBillingProvider().parseWebhookEvent(badPayload)).toBeNull();
    });
  });
});
