import "server-only";
import { headers } from "next/headers";
import { MOCK_WEBHOOK_SIGNATURE_HEADER } from "@/lib/billing/provider/mock-provider";

/**
 * Billing & Subscriptions Stage 4 (this stage's own §14). Shared by both
 * mock checkout/portal Server Actions — the one place that actually fires
 * an HTTP request at this app's own real `/api/billing/webhook` route.
 * Never called from the adapter itself (src/lib/billing/provider/
 * mock-provider.ts stays a pure builder, no network calls of its own);
 * only this TEST_MODE-only UI layer performs the request.
 *
 * `headers()` reads the *incoming* request's own host — the exact same
 * pattern src/lib/storage/attachments-storage.ts's own TEST_MODE branch
 * already uses, never a hardcoded origin or an env var that could point
 * at the wrong port during an E2E run.
 */
async function resolveAppOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("host") ?? "127.0.0.1";
  const proto = h.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

export async function postMockWebhookEvent(rawBody: string, signatureHeader: string): Promise<void> {
  const origin = await resolveAppOrigin();
  const response = await fetch(`${origin}/api/billing/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [MOCK_WEBHOOK_SIGNATURE_HEADER]: signatureHeader,
    },
    body: rawBody,
  });
  if (!response.ok) {
    throw new Error("Mock webhook delivery failed.");
  }
}
