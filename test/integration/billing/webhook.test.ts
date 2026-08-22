import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The webhook route resolves its adapter via getBillingProviderAdapter()
// (src/lib/billing/provider/provider.ts), which only ever returns the real
// MockBillingProvider under TEST_MODE — mocking test-mode.ts here is what
// lets this file exercise the *real* signature-verify → parse → map →
// apply pipeline end to end, against the real (test) Postgres. See
// test/unit/cron-auth.test.ts's own header comment for the "server-only"
// mock.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/test-mode", () => ({ TEST_MODE: true }));

import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/billing/webhook/route";
import {
  buildMockWebhookRequest,
  deriveMockCustomerId,
  deriveMockSubscriptionId,
  mockPeriodEnd,
  MOCK_WEBHOOK_SIGNATURE_HEADER,
} from "@/lib/billing/provider/mock-provider";
import { seedTestData, cleanupTestData, type TestFixtures } from "../../fixtures/seed";

const DAY_MS = 24 * 60 * 60 * 1000;

function toRequest(rawBody: string, signatureHeader: string | null): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (signatureHeader !== null) headers[MOCK_WEBHOOK_SIGNATURE_HEADER] = signatureHeader;
  return new Request("http://127.0.0.1/api/billing/webhook", { method: "POST", headers, body: rawBody });
}

describe("POST /api/billing/webhook", () => {
  let fixtures: TestFixtures;

  beforeAll(async () => {
    fixtures = await seedTestData();
  });

  afterEach(async () => {
    await prisma.webhookEvent.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
    await prisma.notification.deleteMany({ where: { organizationId: fixtures.orgA.id } });
    await prisma.subscription.deleteMany({ where: { organizationId: { in: [fixtures.orgA.id, fixtures.orgB.id] } } });
  });

  afterAll(async () => {
    await cleanupTestData(fixtures);
  });

  function activatedPayload(overrides: Partial<Parameters<typeof buildMockWebhookRequest>[0]> = {}) {
    const now = new Date();
    return buildMockWebhookRequest({
      eventType: "SUBSCRIPTION_ACTIVATED",
      organizationId: fixtures.orgA.id,
      providerCustomerId: deriveMockCustomerId(fixtures.orgA.id),
      providerSubscriptionId: deriveMockSubscriptionId(fixtures.orgA.id),
      planKey: "STARTER",
      status: "ACTIVE",
      currentPeriodStart: now,
      currentPeriodEnd: mockPeriodEnd(now),
      cancelAtPeriodEnd: false,
      trialEnd: null,
      now,
      providerEventId: randomUUID(),
      ...overrides,
    });
  }

  it("a valid, signed event updates the Subscription row and records a PROCESSED WebhookEvent", async () => {
    const { rawBody, signatureHeader } = activatedPayload();

    const response = await POST(toRequest(rawBody, signatureHeader));
    expect(response.status).toBe(200);

    const subscription = await prisma.subscription.findUnique({ where: { organizationId: fixtures.orgA.id } });
    expect(subscription?.status).toBe("ACTIVE");
    expect(subscription?.planKey).toBe("STARTER");
    expect(subscription?.providerCustomerId).toBe(deriveMockCustomerId(fixtures.orgA.id));

    const webhookEvent = await prisma.webhookEvent.findUnique({ where: { providerEventId: JSON.parse(rawBody).id } });
    expect(webhookEvent?.processingStatus).toBe("PROCESSED");
    expect(webhookEvent?.organizationId).toBe(fixtures.orgA.id);
    expect(webhookEvent?.attempts).toBe(1);
  });

  it("an invalid signature is rejected with no DB write at all", async () => {
    const { rawBody } = activatedPayload();

    const response = await POST(toRequest(rawBody, "not-the-real-signature"));
    expect(response.status).toBe(400);

    const subscription = await prisma.subscription.findUnique({ where: { organizationId: fixtures.orgA.id } });
    expect(subscription).toBeNull();
    const webhookEvent = await prisma.webhookEvent.findUnique({ where: { providerEventId: JSON.parse(rawBody).id } });
    expect(webhookEvent).toBeNull();
  });

  it("a missing signature header is rejected with no DB write", async () => {
    const { rawBody } = activatedPayload();
    const response = await POST(toRequest(rawBody, null));
    expect(response.status).toBe(400);
    const webhookEvent = await prisma.webhookEvent.findUnique({ where: { providerEventId: JSON.parse(rawBody).id } });
    expect(webhookEvent).toBeNull();
  });

  it("a duplicate delivery of the exact same event is a safe no-op — Subscription/WebhookEvent unchanged, no reprocessing", async () => {
    const { rawBody, signatureHeader } = activatedPayload();

    const first = await POST(toRequest(rawBody, signatureHeader));
    expect(first.status).toBe(200);
    const afterFirst = await prisma.subscription.findUnique({ where: { organizationId: fixtures.orgA.id } });

    const second = await POST(toRequest(rawBody, signatureHeader));
    expect(second.status).toBe(200);
    const afterSecond = await prisma.subscription.findUnique({ where: { organizationId: fixtures.orgA.id } });

    expect(afterSecond).toEqual(afterFirst);
    const webhookEventCount = await prisma.webhookEvent.count({ where: { providerEventId: JSON.parse(rawBody).id } });
    expect(webhookEventCount).toBe(1);
  });

  it("an older event (by providerUpdatedAt) than what's already applied is ignored, never regresses state", async () => {
    const now = new Date();
    const first = activatedPayload({ planKey: "PRO", now, providerEventId: randomUUID() });
    await POST(toRequest(first.rawBody, first.signatureHeader));

    const olderNow = new Date(now.getTime() - 2 * DAY_MS);
    const older = activatedPayload({ planKey: "STARTER", now: olderNow, providerEventId: randomUUID() });
    const response = await POST(toRequest(older.rawBody, older.signatureHeader));
    expect(response.status).toBe(200);

    const subscription = await prisma.subscription.findUnique({ where: { organizationId: fixtures.orgA.id } });
    // Still PRO — the older, out-of-order STARTER event never applied.
    expect(subscription?.planKey).toBe("PRO");

    const olderEvent = await prisma.webhookEvent.findUnique({ where: { providerEventId: JSON.parse(older.rawBody).id } });
    expect(olderEvent?.processingStatus).toBe("IGNORED");
  });

  it("a plan change on an already-active subscription updates planKey and creates a PLAN_CHANGED notification for the OWNER", async () => {
    const now = new Date();
    const activation = activatedPayload({ planKey: "STARTER", now });
    await POST(toRequest(activation.rawBody, activation.signatureHeader));

    const later = new Date(now.getTime() + DAY_MS);
    const planChange = activatedPayload({
      eventType: "SUBSCRIPTION_UPDATED",
      planKey: "PRO",
      now: later,
      providerEventId: randomUUID(),
    });
    const response = await POST(toRequest(planChange.rawBody, planChange.signatureHeader));
    expect(response.status).toBe(200);

    const subscription = await prisma.subscription.findUnique({ where: { organizationId: fixtures.orgA.id } });
    expect(subscription?.planKey).toBe("PRO");

    const notification = await prisma.notification.findFirst({
      where: { organizationId: fixtures.orgA.id, type: "PLAN_CHANGED" },
    });
    expect(notification).not.toBeNull();
    expect(notification?.recipientId).toBe(fixtures.owner.id);
    expect(notification?.activityId).toBeNull();
  });

  it("a first-time activation creates SUBSCRIPTION_ACTIVATED, never also a redundant PLAN_CHANGED", async () => {
    const { rawBody, signatureHeader } = activatedPayload();
    await POST(toRequest(rawBody, signatureHeader));

    const activated = await prisma.notification.count({ where: { organizationId: fixtures.orgA.id, type: "SUBSCRIPTION_ACTIVATED" } });
    const planChanged = await prisma.notification.count({ where: { organizationId: fixtures.orgA.id, type: "PLAN_CHANGED" } });
    expect(activated).toBe(1);
    expect(planChanged).toBe(0);
  });

  it("a cancellation sets status CANCELED and creates a SUBSCRIPTION_CANCELED notification", async () => {
    const now = new Date();
    const activation = activatedPayload({ now });
    await POST(toRequest(activation.rawBody, activation.signatureHeader));

    const later = new Date(now.getTime() + DAY_MS);
    const cancel = activatedPayload({
      eventType: "SUBSCRIPTION_CANCELED",
      status: "CANCELED",
      cancelAtPeriodEnd: true,
      now: later,
      providerEventId: randomUUID(),
    });
    const response = await POST(toRequest(cancel.rawBody, cancel.signatureHeader));
    expect(response.status).toBe(200);

    const subscription = await prisma.subscription.findUnique({ where: { organizationId: fixtures.orgA.id } });
    expect(subscription?.status).toBe("CANCELED");
    expect(subscription?.canceledAt).not.toBeNull();

    const notification = await prisma.notification.findFirst({
      where: { organizationId: fixtures.orgA.id, type: "SUBSCRIPTION_CANCELED" },
    });
    expect(notification).not.toBeNull();
  });

  it("a payment failure sets status PAST_DUE with a 7-day grace period and creates a PAYMENT_FAILED notification", async () => {
    const now = new Date();
    const activation = activatedPayload({ now });
    await POST(toRequest(activation.rawBody, activation.signatureHeader));

    const later = new Date(now.getTime() + DAY_MS);
    const pastDue = activatedPayload({
      eventType: "SUBSCRIPTION_PAST_DUE",
      status: "PAST_DUE",
      now: later,
      providerEventId: randomUUID(),
    });
    const response = await POST(toRequest(pastDue.rawBody, pastDue.signatureHeader));
    expect(response.status).toBe(200);

    const subscription = await prisma.subscription.findUnique({ where: { organizationId: fixtures.orgA.id } });
    expect(subscription?.status).toBe("PAST_DUE");
    expect(subscription?.gracePeriodEndsAt).not.toBeNull();

    const notification = await prisma.notification.findFirst({
      where: { organizationId: fixtures.orgA.id, type: "PAYMENT_FAILED" },
    });
    expect(notification).not.toBeNull();
  });

  it("an event claiming a nonexistent organization is rejected and recorded FAILED, with no Subscription write", async () => {
    const { rawBody, signatureHeader } = activatedPayload({ organizationId: randomUUID() });
    const response = await POST(toRequest(rawBody, signatureHeader));
    expect(response.status).toBe(200);

    const webhookEvent = await prisma.webhookEvent.findUnique({ where: { providerEventId: JSON.parse(rawBody).id } });
    expect(webhookEvent?.processingStatus).toBe("FAILED");
    expect(webhookEvent?.failureCode).toBe("unknown_organization");
    expect(webhookEvent?.organizationId).toBeNull();
  });

  it("an event with no organizationId claim at all is rejected and recorded FAILED", async () => {
    const { rawBody, signatureHeader } = activatedPayload({ organizationId: null });
    const response = await POST(toRequest(rawBody, signatureHeader));
    expect(response.status).toBe(200);

    const webhookEvent = await prisma.webhookEvent.findUnique({ where: { providerEventId: JSON.parse(rawBody).id } });
    expect(webhookEvent?.processingStatus).toBe("FAILED");
    expect(webhookEvent?.failureCode).toBe("missing_organization");
  });

  it("a provider customer id already bound to a different org's Subscription is rejected as a conflict — no cross-org reassignment", async () => {
    // orgB already has a Subscription with this customer id.
    const conflictingCustomerId = `mock_cus_shared_${randomUUID()}`;
    await prisma.subscription.create({
      data: {
        organizationId: fixtures.orgB.id,
        planKey: "STARTER",
        status: "ACTIVE",
        providerCustomerId: conflictingCustomerId,
        trialStartedAt: new Date(),
        trialEndsAt: new Date(),
      },
    });

    const { rawBody, signatureHeader } = activatedPayload({ providerCustomerId: conflictingCustomerId });
    const response = await POST(toRequest(rawBody, signatureHeader));
    expect(response.status).toBe(200);

    const webhookEvent = await prisma.webhookEvent.findUnique({ where: { providerEventId: JSON.parse(rawBody).id } });
    expect(webhookEvent?.processingStatus).toBe("FAILED");
    expect(webhookEvent?.failureCode).toBe("provider_id_conflict");

    // orgA never got a Subscription row out of this rejected event.
    const orgASubscription = await prisma.subscription.findUnique({ where: { organizationId: fixtures.orgA.id } });
    expect(orgASubscription).toBeNull();
  });

  it("never creates a duplicate Notification when the same event is somehow reprocessed (defense in depth alongside the WebhookEvent-level dedup)", async () => {
    const { rawBody, signatureHeader } = activatedPayload();
    await POST(toRequest(rawBody, signatureHeader));
    await POST(toRequest(rawBody, signatureHeader));

    const count = await prisma.notification.count({ where: { organizationId: fixtures.orgA.id, type: "SUBSCRIPTION_ACTIVATED" } });
    expect(count).toBe(1);
  });

  it("creates no Activity row for any billing event — Notification rows stand alone", async () => {
    const before = await prisma.activity.count({ where: { organizationId: fixtures.orgA.id } });
    const { rawBody, signatureHeader } = activatedPayload();
    await POST(toRequest(rawBody, signatureHeader));
    const after = await prisma.activity.count({ where: { organizationId: fixtures.orgA.id } });
    expect(after).toBe(before);
  });

  it("an unconfigured provider (TEST_MODE off) fails closed with no DB write", async () => {
    vi.resetModules();
    vi.doMock("@/lib/test-mode", () => ({ TEST_MODE: false }));
    const { POST: unconfiguredPost } = await import("@/app/api/billing/webhook/route");

    const { rawBody, signatureHeader } = activatedPayload({ providerEventId: randomUUID() });
    const response = await unconfiguredPost(toRequest(rawBody, signatureHeader));
    expect(response.status).toBe(400);

    const webhookEvent = await prisma.webhookEvent.findUnique({ where: { providerEventId: JSON.parse(rawBody).id } });
    expect(webhookEvent).toBeNull();

    vi.doUnmock("@/lib/test-mode");
    vi.resetModules();
  });
});
