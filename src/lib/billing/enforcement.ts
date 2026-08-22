import { prisma } from "@/lib/prisma";
import { getOrganizationEntitlements, type EntitlementReasonCode } from "./entitlements";
import type { PrismaClientOrTx } from "./usage";

/**
 * Billing & Subscriptions Stage 2 (docs/billing-architecture.md §11/§13's
 * error contract). The one, typed, controlled domain error every
 * enforcement helper below throws — never a raw Prisma error, never a
 * provider error, never anything that reveals database/provider internals.
 * `message` is always one of the fixed, generic, user-facing strings in
 * REASON_MESSAGES — safe to show directly in a form's existing error UI
 * with no further sanitization.
 */
export class BillingLimitError extends Error {
  readonly reasonCode: EntitlementReasonCode;

  constructor(reasonCode: EntitlementReasonCode) {
    super(REASON_MESSAGES[reasonCode]);
    this.name = "BillingLimitError";
    this.reasonCode = reasonCode;
  }
}

/**
 * Deliberately generic and provider-silent (docs/billing-architecture.md
 * §13's error contract): never a provider status, never a provider
 * customer/subscription id, never a price id, never a raw counter beyond
 * what the calling UI already asked for, never a database error message.
 */
export const REASON_MESSAGES: Readonly<Record<EntitlementReasonCode, string>> = {
  MEMBER_LIMIT_REACHED: "Your plan's member limit has been reached.",
  CLIENT_LIMIT_REACHED: "Your plan's client limit has been reached.",
  PROJECT_LIMIT_REACHED: "Your plan's project limit has been reached.",
  STORAGE_LIMIT_REACHED: "Your storage limit has been reached.",
  READ_ONLY_ACCESS: "Your subscription currently allows read-only access.",
} as const;

/**
 * Every assert* helper below:
 *   - takes a server-resolved organizationId only (never client input —
 *     every call site resolves it via getCurrentUserOrganization()/
 *     getCurrentMembership() before calling this, docs/billing-
 *     architecture.md §15's "no client-supplied organizationId" rule);
 *   - accepts an explicit Prisma client (default: the app singleton) so a
 *     caller can pass its own `tx` for an atomic re-check immediately
 *     before the write it's guarding — see each helper's own doc comment
 *     for its concurrency guarantee;
 *   - throws BillingLimitError (never returns a boolean) so a call site
 *     that forgets to check a return value fails loudly instead of
 *     silently allowing an over-limit write;
 *   - never trusts a client-supplied plan/status/usage number — every
 *     value comes from getOrganizationEntitlements()'s own DB-backed read.
 */

/**
 * Concurrency: called from inside the same `prisma.$transaction(...)` as
 * the Invitation upsert it guards (see team/actions.ts), so the member/
 * pending-invitation count this reads is the transaction's own consistent
 * snapshot, re-read immediately before the write — the same pattern
 * getOrCreateOrganizationId() already uses for its own race (concurrent
 * first-login prefetches). Two near-simultaneous invites at exactly the
 * limit can still both pass a read taken *before* either transaction
 * opened; once inside the transaction, Postgres's own read-committed
 * isolation (this app's default, unchanged by this stage) means the
 * second transaction's re-read sees the first's already-committed insert
 * only if the first has already committed — so the residual race is
 * narrow (both transactions opened and read concurrently, before either
 * committed) and its worst outcome is a small, temporary oversubscription
 * (one extra invitation over the limit), never data loss or a security
 * issue. docs/billing-architecture.md §7 explicitly accepts this exact
 * trade-off rather than adding distributed locking for v1.
 */
export async function assertCanInviteMember(
  organizationId: string,
  client: PrismaClientOrTx = prisma,
): Promise<void> {
  const entitlements = await getOrganizationEntitlements(organizationId, { client });
  if (entitlements.canInviteMember) return;
  throw new BillingLimitError(
    entitlements.accessMode !== "FULL_ACCESS" ? "READ_ONLY_ACCESS" : "MEMBER_LIMIT_REACHED",
  );
}

/** Same atomic-re-check/residual-race reasoning as assertCanInviteMember, guarding the Client `create` in clients/new/actions.ts's own transaction. */
export async function assertCanCreateClient(
  organizationId: string,
  client: PrismaClientOrTx = prisma,
): Promise<void> {
  const entitlements = await getOrganizationEntitlements(organizationId, { client });
  if (entitlements.canCreateClient) return;
  throw new BillingLimitError(
    entitlements.accessMode !== "FULL_ACCESS" ? "READ_ONLY_ACCESS" : "CLIENT_LIMIT_REACHED",
  );
}

/** Same atomic-re-check/residual-race reasoning as assertCanInviteMember, guarding the Project `create` in projects/new/actions.ts's own transaction. */
export async function assertCanCreateProject(
  organizationId: string,
  client: PrismaClientOrTx = prisma,
): Promise<void> {
  const entitlements = await getOrganizationEntitlements(organizationId, { client });
  if (entitlements.canCreateProject) return;
  throw new BillingLimitError(
    entitlements.accessMode !== "FULL_ACCESS" ? "READ_ONLY_ACCESS" : "PROJECT_LIMIT_REACHED",
  );
}

/**
 * Concurrency, deliberately weaker than the three helpers above: the
 * upload flow (uploadAttachmentForEntity in
 * src/lib/attachments/attachment-mutations.ts) already performs its own
 * pre-existing per-entity count check as a plain read *before* the Storage
 * upload, not inside a transaction — Storage isn't transactional with
 * Postgres, so no check here can be made airtight against that boundary.
 * This check follows that exact same established, already-accepted
 * precedent (read the current storage sum, decide, then upload) rather
 * than inventing a stronger guarantee only for the new billing dimension.
 * Residual risk: two near-simultaneous uploads that would each
 * individually fit under the quota, but not both together, can both pass
 * this check and land — a small, temporary storage-quota overshoot, never
 * a security issue or data loss, and self-correcting the next time either
 * upload is attempted after the other has committed.
 */
export async function assertCanUploadAttachment(
  organizationId: string,
  sizeBytes: number,
  client: PrismaClientOrTx = prisma,
): Promise<void> {
  const entitlements = await getOrganizationEntitlements(organizationId, { client });
  if (entitlements.canUploadBytes(sizeBytes)) return;
  throw new BillingLimitError(
    entitlements.accessMode !== "FULL_ACCESS" ? "READ_ONLY_ACCESS" : "STORAGE_LIMIT_REACHED",
  );
}
