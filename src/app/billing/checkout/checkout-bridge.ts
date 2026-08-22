import { sanitizeRedirectPath } from "@/lib/safe-redirect";

/**
 * Sale-Ready Phase E, E2.5 (Paddle Checkout UX / Hosted Checkout Bridge).
 * Pure parsing/validation for the query params
 * `src/lib/billing/provider/paddle-provider.ts`'s own
 * `buildCheckoutBridgeUrl` embeds on `/billing/checkout`'s URL, kept in
 * its own file (rather than inline in `page.tsx`) specifically so it can
 * be unit-tested without a DOM/React rendering environment — this
 * project has neither `@testing-library/react` nor a `jsdom` test
 * environment configured, and this PR doesn't add either just for one
 * page; every branch that actually needs testing lives here instead,
 * pure and framework-free.
 */

export type PaddleClientEnvironment = "sandbox" | "live";

export type CheckoutBridgeQueryParams = {
  transactionId: string | null;
  environment: string | null;
  returnUrl: string | null;
  cancelUrl: string | null;
};

export type ResolvedCheckoutBridge = {
  transactionId: string;
  environment: PaddleClientEnvironment;
  /** Relative, same-origin, sanitized — resolved to an absolute URL only once actually needed (see `buildSuccessUrl` below), since that step needs `window.location.origin` and this function must stay safely callable during server rendering, before a `window` exists. */
  returnPath: string;
  /** Relative, same-origin — used for an in-app `router.push`, never a full-page `window.location` navigation. */
  cancelPath: string;
};

export type CheckoutBridgeResolution =
  | { ok: true; bridge: ResolvedCheckoutBridge }
  | { ok: false; reason: "missing_transaction_id" | "missing_or_invalid_environment" };

const BILLING_FALLBACK_PATH = "/settings/billing";

function isPaddleClientEnvironment(value: string | null): value is PaddleClientEnvironment {
  return value === "sandbox" || value === "live";
}

/**
 * Pure — no DOM, no network, no React, and deliberately safe to call
 * during server rendering (no `window`/`origin` dependency — see
 * `ResolvedCheckoutBridge.returnPath`'s own comment). This page is a
 * public route (see `page.tsx`'s own header comment for why no auth gate
 * is needed) and is therefore reachable with an arbitrary,
 * attacker-crafted query string — every value here is validated exactly
 * as if it were untrusted input, even though the happy-path caller (this
 * app's own adapter) always sends well-formed values. Fails closed to a
 * typed `{ ok: false }` result for anything missing or malformed, never
 * a thrown exception and never a guessed default for
 * `transactionId`/`environment` specifically (a wrong guess there could
 * open a checkout in the wrong Paddle environment, or none at all) —
 * `returnUrl`/`cancelUrl` are the only two fields with a safe,
 * well-defined fallback (`sanitizeRedirectPath`'s own `/settings/billing`
 * default), the same fallback every other redirect target in this app
 * already uses; they are never assumed safe just because the URL that
 * generated them was.
 */
export function resolveCheckoutBridgeParams(params: CheckoutBridgeQueryParams): CheckoutBridgeResolution {
  const transactionId = params.transactionId?.trim();
  if (!transactionId) {
    return { ok: false, reason: "missing_transaction_id" };
  }

  if (!isPaddleClientEnvironment(params.environment)) {
    return { ok: false, reason: "missing_or_invalid_environment" };
  }

  return {
    ok: true,
    bridge: {
      transactionId,
      environment: params.environment,
      returnPath: sanitizeRedirectPath(params.returnUrl, BILLING_FALLBACK_PATH),
      cancelPath: sanitizeRedirectPath(params.cancelUrl, BILLING_FALLBACK_PATH),
    },
  };
}

/**
 * Resolves a relative, sanitized path (`ResolvedCheckoutBridge.returnPath`)
 * to the absolute URL Paddle.js's `settings.successUrl` actually needs
 * (it redirects the top-level browser window, so a same-origin relative
 * path alone isn't enough). Split out from `resolveCheckoutBridgeParams`
 * specifically so that function stays server-render-safe — this one is
 * only ever called client-side, inside an effect, once `window` is
 * guaranteed to exist.
 */
export function buildSuccessUrl(returnPath: string, origin: string): string {
  return new URL(returnPath, origin).toString();
}
