/**
 * Client Portal welcome banner — Stage 4 (docs/onboarding-architecture.md
 * §17). Deliberately the ONLY piece of logic behind the banner: no new
 * table, no `PortalUser.welcomedAt` column, no migration. §17 left the
 * exact signal open ("a persisted flag ... or can be inferred from
 * PortalUser.createdAt being recent, left to Stage 2 to settle
 * empirically") — Stage 2 never touched the Portal side at all, so this is
 * where that decision actually gets made: inferred from `createdAt`, the
 * zero-migration option, since nothing about a fresh `PortalUser` needs a
 * new persisted fact to know it's fresh.
 *
 * `PortalUser` is created exactly once, at ClientInvitation-accept time
 * (src/app/portal/invite/[token]/actions.ts), and that accept flow
 * redirects straight to /portal — so `createdAt` is a genuinely reliable
 * "just onboarded" signal, not a guess. The window is 7 days, mirroring
 * this codebase's own existing "one week" convention for invitation
 * validity (Invitation/ClientInvitation both use `expiresAt: now + 7
 * days` — see test/fixtures/seed.ts) rather than an arbitrary new number.
 */
export const PORTAL_WELCOME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function isPortalWelcomeEligible(portalUserCreatedAt: Date, now: Date): boolean {
  return now.getTime() - portalUserCreatedAt.getTime() < PORTAL_WELCOME_WINDOW_MS;
}
