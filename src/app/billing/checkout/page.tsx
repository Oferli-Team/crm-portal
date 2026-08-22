"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { initializePaddle, CheckoutEventNames, type Paddle, type PaddleEventData } from "@paddle/paddle-js";
import { resolveCheckoutBridgeParams, buildSuccessUrl } from "./checkout-bridge";

/**
 * Sale-Ready Phase E, E2.5 (Paddle Checkout UX / Hosted Checkout Bridge).
 * The client-side half of the checkout bridge — the server-side half is
 * `src/lib/billing/provider/paddle-provider.ts`'s own
 * `createCheckoutSession`/`buildCheckoutBridgeUrl`, which is the only
 * thing that ever redirects a browser here (with `transactionId`,
 * `environment`, `returnUrl`, `cancelUrl` on the query string). This
 * page's whole job is opening a Paddle.js overlay checkout for that
 * transaction and getting the user back to `/settings/billing` either
 * way (success or cancel) — it never talks to this app's own backend,
 * never touches `Subscription`, and never decides whether a purchase
 * succeeded. Real payment/subscription state only ever changes via the
 * Paddle webhook (`src/app/api/billing/webhook/route.ts`); the existing
 * `?checkout=success` notice on `/settings/billing`
 * (`src/app/(dashboard)/settings/billing/page.tsx`, Stage 4) already
 * covers the "user came back before the webhook did" pending state, so
 * nothing here needs to duplicate that.
 *
 * Why Paddle.js at all, and not a plain server-driven redirect to
 * Paddle's own hosted checkout: confirmed during E2.5's own research
 * that a transaction's `checkout.url` only resolves to a fully working,
 * no-Paddle.js-required page under Paddle's separate, sales-team-gated
 * "Hosted Checkout" feature (requires emailing sellers@paddle.com,
 * live-accounts only) — not something guaranteed available to every
 * future buyer's self-serve Paddle account. The overlay checkout built
 * here (`Paddle.Checkout.open({ transactionId })`) is the standard,
 * self-serve, officially documented path every real Paddle Billing
 * integration uses, gated only on the normal (auto-approved in sandbox,
 * fast/automatic in most live cases) domain-approval step every
 * Paddle.js integration needs regardless of which specific flow is
 * used.
 *
 * Deliberately a public route, no auth check — this page makes no trust
 * decision of its own (see `checkout-bridge.ts`'s own header comment):
 * `transactionId` is an opaque string only ever passed through to
 * Paddle.js, and the transaction it refers to already carries whichever
 * organization's `custom_data.organizationId` this app's own
 * `createCheckoutSession` embedded server-side, before this page was
 * ever reached — nothing here trusts the *visitor's* identity for
 * anything. `requestPlanChangeAction` (the only real caller) already
 * fully authorizes (OWNER-only, server-resolved org) before ever
 * creating the transaction or redirecting here.
 *
 * `useSearchParams()` requires a Suspense boundary in the App Router —
 * the same pattern `src/app/layout.tsx` already uses for
 * `ToastListener`.
 */

const CLIENT_TOKEN = process.env.NEXT_PUBLIC_BILLING_CLIENT_TOKEN;

const INVALID_LINK_MESSAGE = "This checkout link is invalid or has expired. Please go back and try again.";
const MISSING_TOKEN_MESSAGE = "Billing isn't fully configured yet — a client-side checkout token is missing. Please contact support.";
const OPEN_FAILED_MESSAGE = "Couldn't start checkout. Please go back and try again.";

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-4 py-16 text-center">
      {children}
    </div>
  );
}

function CheckoutBridge() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [openError, setOpenError] = useState<string | null>(null);

  // Pure, synchronous, server-render-safe (see resolveCheckoutBridgeParams's
  // own header comment) — computed during render, not inside an effect,
  // so an invalid/missing param never needs a setState-in-effect round
  // trip to be reflected in what's rendered.
  const resolution = resolveCheckoutBridgeParams({
    transactionId: searchParams.get("transactionId"),
    environment: searchParams.get("environment"),
    returnUrl: searchParams.get("returnUrl"),
    cancelUrl: searchParams.get("cancelUrl"),
  });
  const configErrorMessage = !resolution.ok ? INVALID_LINK_MESSAGE : !CLIENT_TOKEN ? MISSING_TOKEN_MESSAGE : null;

  useEffect(() => {
    // Nothing to do (and nothing safe to do) once config is already
    // known to be bad — the render above already reflects that.
    if (configErrorMessage || !resolution.ok || !CLIENT_TOKEN) return;

    const { transactionId, environment, returnPath, cancelPath } = resolution.bridge;
    let cancelled = false;

    initializePaddle({
      // This app's own "sandbox"/"live" vocabulary (paddle-config.ts's
      // own PaddleEnvironment) maps to Paddle.js's own "sandbox"/
      // "production" Environments type — the same mapping already used
      // server-side in paddle-client.ts's own createPaddleSdkClient.
      environment: environment === "live" ? "production" : "sandbox",
      token: CLIENT_TOKEN,
      eventCallback(event: PaddleEventData) {
        if (event.name === CheckoutEventNames.CHECKOUT_CLOSED) {
          router.push(cancelPath);
        }
      },
    })
      .then((paddle: Paddle | undefined) => {
        if (cancelled) return;
        if (!paddle) {
          setOpenError(OPEN_FAILED_MESSAGE);
          return;
        }
        paddle.Checkout.open({
          transactionId,
          settings: { successUrl: buildSuccessUrl(returnPath, window.location.origin) },
        });
      })
      .catch(() => {
        if (!cancelled) setOpenError(OPEN_FAILED_MESSAGE);
      });

    return () => {
      cancelled = true;
    };
    // Reads only the query params present on first render — this page is
    // never navigated within itself, so re-running on searchParams
    // identity changes would only ever re-open a second overlay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configErrorMessage]);

  const errorMessage = configErrorMessage ?? openError;
  if (errorMessage) {
    return (
      <CenteredMessage>
        <h1 className="text-xl font-semibold tracking-tight text-gray-900">Checkout unavailable</h1>
        <p className="mt-2 text-sm text-gray-500">{errorMessage}</p>
        <Link href="/settings/billing" className="mt-6 text-sm font-medium text-gray-900 underline hover:text-gray-700">
          Back to Billing
        </Link>
      </CenteredMessage>
    );
  }

  return (
    <CenteredMessage>
      <p className="text-sm text-gray-500">Redirecting to secure checkout…</p>
    </CenteredMessage>
  );
}

export default function CheckoutBridgePage() {
  return (
    <Suspense
      fallback={
        <CenteredMessage>
          <p className="text-sm text-gray-500">Loading…</p>
        </CenteredMessage>
      }
    >
      <CheckoutBridge />
    </Suspense>
  );
}
