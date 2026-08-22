import "server-only";
import { Environment, Paddle } from "@paddle/paddle-node-sdk";
import type { PaddleProviderConfig } from "./paddle-config";

/**
 * Sale-Ready Phase E, E2.3 (Paddle Provider Core). A minimal seam between
 * the real `@paddle/paddle-node-sdk` client and `paddle-provider.ts` —
 * exists purely so unit tests can substitute a fully-mocked client (no
 * network, no real SDK instance) without touching `createPaddleSdkClient`
 * itself, the same dependency-injection shape this codebase already uses
 * elsewhere (e.g. `sendInvitationEmail`'s own `sendEmail` DI parameter).
 *
 * Deliberately narrowed to exactly the two methods this adapter actually
 * calls (`transactions.create`, `customerPortalSessions.create`) rather
 * than the real SDK's full `Paddle` instance shape (which also exposes
 * `products`, `prices`, `subscriptions`, `webhooks`, and many more
 * resources this adapter never touches) — a test fake only ever needs to
 * implement these two methods, and this type is still checked structurally
 * against the real SDK's own method signatures (via `Paddle["transactions"]
 * ["create"]` etc.), so it can never silently drift from what the real
 * client actually returns.
 */
export type PaddleSdkClient = {
  transactions: {
    create: Paddle["transactions"]["create"];
  };
  customerPortalSessions: {
    create: Paddle["customerPortalSessions"]["create"];
  };
};

/**
 * Constructs a real Paddle SDK client — no network call happens here
 * (confirmed against the SDK's own source: the constructor only stores
 * the API key/options, every actual request happens lazily on a
 * resource method call). `config.environment` ("sandbox" | "live", this
 * app's own vocabulary from `paddle-config.ts`) maps to the SDK's own
 * `Environment` enum, which uses "production" rather than "live" as its
 * value name — this mapping is the only place that naming difference
 * needs to exist.
 */
export function createPaddleSdkClient(config: PaddleProviderConfig): PaddleSdkClient {
  return new Paddle(config.apiKey, {
    environment: config.environment === "live" ? Environment.production : Environment.sandbox,
  });
}
