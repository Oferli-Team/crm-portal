import "server-only";
import { formatStatusLabel } from "@/lib/format";
import { getBillingProviderAdapter } from "./provider/provider";
import { getPaddleProviderConfig } from "./provider/paddle-config";
import { getBillingProviderAvailability } from "./provider-availability";

export type PlatformBillingMode = "Test" | "Sandbox" | "Live" | "Not configured";

/**
 * Sale-Ready Phase D, D4 (Platform Configuration — Billing Configuration).
 * A read-only projection of the billing subsystem's own existing
 * abstraction (src/lib/billing/provider/provider.ts,
 * src/lib/billing/provider-availability.ts) — never a second billing
 * configuration system, never a network call (getBillingProviderAdapter(),
 * getPaddleProviderConfig(), and getBillingProviderAvailability() already
 * make none: the first two only branch on env vars/TEST_MODE, the third
 * only inspects the resolved adapter's own `kind`/`name`).
 *
 * Stage 4 has no partial-configuration state: checkoutAvailable and
 * portalAvailable are already identical to `configured` in
 * provider-availability.ts today, and webhook verification / plan
 * synchronization (the webhook → event-mapper → provisioning pipeline)
 * are equally gated on having a working adapter to receive events from —
 * there is no separate on/off switch for any one of these yet. This type
 * still gives each its own field so a future real provider integration
 * (where these genuinely could diverge — e.g. checkout working but a
 * webhook secret missing) is a value change here, never a page redesign.
 *
 * Sale-Ready Phase E, E2.6 (Paddle Provider Resolver Activation): now
 * that `getBillingProviderAdapter()` can genuinely resolve to the real
 * Paddle adapter (`adapter.kind === "paddle"`), `mode` distinguishes
 * Paddle's own `sandbox` environment from `live` — collapsing both into
 * a single "Live" label (the pre-E2.6 behavior, written when a "paddle"
 * adapter.kind was still unreachable in practice) would have
 * misleadingly shown "Live" for a sandbox (test-money) Paddle
 * connection. Nothing secret is read for this — `getPaddleProviderConfig()`'s
 * own `environment` field is not sensitive (unlike `apiKey`/
 * `webhookSecret`/price ids, none of which this module — or the page
 * that renders it — ever reads or displays).
 */
export type PlatformBillingConfig = {
  /** Formatted from the adapter's own `name` (BillingProvider enum) — every adapter, mock and unconfigured alike, already reports "PADDLE" (the only value the enum has today; see src/lib/billing/provider/unconfigured-provider.ts and mock-provider.ts). Never invented independently of that value. */
  providerName: string;
  /** The same fact src/lib/billing/provider-availability.ts's own `configured` flag already reports to every checkout/portal Server Action — true when TEST_MODE resolves to the mock adapter, or when a full, valid Paddle config resolves to the real adapter; always false when neither does. */
  providerConfigured: boolean;
  /** Derived from the adapter's own `kind` discriminant ("mock" | "unconfigured" | "paddle") — plus, only for "paddle", `getPaddleProviderConfig()`'s own `environment` field (non-sensitive) to distinguish Sandbox from Live. Never a second, independent test-vs-live check. */
  mode: PlatformBillingMode;
  checkoutConfigured: boolean;
  customerPortalConfigured: boolean;
  webhookConfigured: boolean;
  planSynchronizationConfigured: boolean;
};

function resolveMode(adapterKind: "mock" | "unconfigured" | "paddle"): PlatformBillingMode {
  if (adapterKind === "mock") return "Test";
  if (adapterKind === "unconfigured") return "Not configured";

  // adapterKind === "paddle" — only reachable at all when
  // getPaddleProviderConfig() itself already returned a fully valid,
  // non-null config (see provider.ts's own resolver logic), so calling
  // it again here is safe, cheap (a handful of process.env reads, no
  // I/O), and guaranteed non-null.
  const config = getPaddleProviderConfig();
  return config?.environment === "live" ? "Live" : "Sandbox";
}

export async function getPlatformBillingConfig(): Promise<PlatformBillingConfig> {
  const adapter = getBillingProviderAdapter();
  const availability = await getBillingProviderAvailability();

  return {
    providerName: formatStatusLabel(adapter.name),
    providerConfigured: availability.configured,
    mode: resolveMode(adapter.kind),
    checkoutConfigured: availability.checkoutAvailable,
    customerPortalConfigured: availability.portalAvailable,
    webhookConfigured: availability.configured,
    planSynchronizationConfigured: availability.configured,
  };
}
