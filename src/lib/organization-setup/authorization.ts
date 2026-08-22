import type { Role } from "@/generated/prisma/enums";

/**
 * Customer Setup Wizard (Stage 6.2). Two distinct boundaries, mirroring
 * this codebase's own existing split between Billing's "everyone can
 * view, OWNER manages" (settings/billing/actions.ts) and Analytics'
 * "MEMBER is a hard block, full stop" (src/lib/analytics/authorization.ts):
 *
 * - Company Profile / Domain Settings: any member of the organization may
 *   read them (unremarkable business facts, the same tier as
 *   Organization.name/slug are already visible to); only OWNER may write.
 * - Payment Details: OWNER-only for BOTH read and write — real bank
 *   details are the one genuinely sensitive concern this stage adds, and
 *   get the stricter Analytics-style page-level block, never merely a
 *   disabled form MEMBER/ADMIN could still see the values of.
 *
 * Client Portal identities never reach any of this: every call site lives
 * under the `(dashboard)` route group, whose layout already redirects any
 * Portal-only identity to `/portal` before these are ever called (same
 * guarantee every other staff-only feature in this app already has).
 */
export class OrganizationSetupAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrganizationSetupAccessError";
  }
}

export function canManageCompanyProfile(role: Role): boolean {
  return role === "OWNER";
}

/** Throws for a non-OWNER — every write path (Server Action) calls this before touching OrganizationProfile/Organization.name. Reads are never gated (any member may view). */
export function assertCanManageCompanyProfile(role: Role): void {
  if (!canManageCompanyProfile(role)) {
    throw new OrganizationSetupAccessError("Only the organization owner can update company details.");
  }
}

export function canAccessPaymentDetails(role: Role): boolean {
  return role === "OWNER";
}

/** Throws for a non-OWNER — the payment-details page itself calls this before ever reading OrganizationPaymentDetails, and the write action calls it again independently (never trusts the page's own check alone). Covers both read and write: this data is never exposed to MEMBER, ADMIN, or a portal identity, full stop. */
export function assertCanAccessPaymentDetails(role: Role): void {
  if (!canAccessPaymentDetails(role)) {
    throw new OrganizationSetupAccessError("Payment details are only available to the organization owner.");
  }
}

export function canManageDomainSettings(role: Role): boolean {
  return role === "OWNER";
}

/** Throws for a non-OWNER — every write path calls this before touching OrganizationDomainSettings. Reads are never gated (any member may view the generated subdomain / configured custom domain). */
export function assertCanManageDomainSettings(role: Role): void {
  if (!canManageDomainSettings(role)) {
    throw new OrganizationSetupAccessError("Only the organization owner can update domain settings.");
  }
}
