import type { PrismaClient } from "../src/generated/prisma/client";
import { createTrialSubscription } from "../src/lib/billing/provisioning";

/**
 * Sale-Ready Phase E, S1.1 (P0). Extracted out of prisma/seed.ts as its own
 * module — not because anything else calls it, but because seed.ts's own
 * `main()` runs immediately at import time (a plain top-level `main()...`
 * call, no `if (require.main === module)` guard), so importing anything
 * from seed.ts itself would re-run the entire seed. This is the "reasonable
 * test seam" the org-connection fix needs: a pure, parameterized module
 * (real PrismaClient passed in, no module-level singleton) that
 * test/integration/seed/demo-organization.test.ts exercises directly
 * against the real PGlite-backed integration database, independent of
 * Supabase Auth (which neither function here touches).
 *
 * Mirrors exactly what `getOrCreateOrganizationId()`
 * (src/lib/current-user.ts) would create lazily on a user's first login —
 * a real Organization, a real OWNER Membership, a real TRIALING
 * Subscription — except created eagerly, at seed time, so a fresh
 * `npm run db:seed` run produces an already-connected demo organization
 * rather than depending on that lazy, request-scoped path ever running.
 */

/**
 * Idempotent: an existing OWNER Membership for this user is reused
 * outright — never a second Organization created for the same user on a
 * re-run.
 */
export async function ensureDemoOrganization(
  prisma: PrismaClient,
  ownerId: string,
  org: { name: string; slug: string },
): Promise<string> {
  const existingOwnerMembership = await prisma.membership.findFirst({
    where: { userId: ownerId, role: "OWNER" },
    select: { organizationId: true },
  });
  if (existingOwnerMembership) {
    return existingOwnerMembership.organizationId;
  }

  return prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: { name: org.name, slug: org.slug },
    });
    await tx.membership.create({
      data: { userId: ownerId, organizationId: organization.id, role: "OWNER" },
    });
    await createTrialSubscription(tx, organization.id, new Date());
    return organization.id;
  });
}

/** Idempotent: a re-run for a (userId, organizationId) pair that's already a member is a silent no-op, never a duplicate-membership error. */
export async function ensureMembership(
  prisma: PrismaClient,
  organizationId: string,
  userId: string,
  role: "OWNER" | "ADMIN" | "MEMBER",
): Promise<void> {
  const existing = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId } },
  });
  if (existing) return;

  await prisma.membership.create({
    data: { userId, organizationId, role },
  });
}
