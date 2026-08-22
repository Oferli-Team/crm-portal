import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getVerifiedAuthUser } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { Role } from "@/generated/prisma/enums";
import { createTrialSubscription } from "@/lib/billing/provisioning";

const ACTIVE_ORG_COOKIE = "active_organization_id";
const ACTIVE_ORG_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function activeOrgCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ACTIVE_ORG_COOKIE_MAX_AGE,
  };
}

/**
 * Ensures a Prisma User row exists for the currently authenticated Supabase
 * user, using the Supabase auth user id as the Prisma User id. Called
 * independently from ~20 pages/actions with no shared request-level cache,
 * so on a first-ever login it's normal for several of these (e.g. Next.js
 * prefetching sidebar links) to race to create the same row concurrently.
 * If this call loses that race, the row now exists (created by the winner),
 * so we just read it back instead of surfacing the P2002.
 *
 * Guards against a Client Portal-only identity (a PortalUser with no staff
 * Membership) ever getting a User/Organization auto-provisioned. This must
 * live here, not only in (dashboard)/layout.tsx's guard, because Next.js
 * background prefetch requests for Sidebar links re-render Server
 * Components independently of whichever page the user is actually looking
 * at — a single guard higher up in the tree doesn't see those.
 */
export async function getOrCreateUser() {
  const authUser = await getVerifiedAuthUser();

  if (!authUser) {
    redirect("/login");
  }

  const existing = await prisma.user.findUnique({ where: { id: authUser.id } });
  if (existing) {
    return existing;
  }

  const portalUser = await prisma.portalUser.findUnique({
    where: { id: authUser.id },
    select: { id: true },
  });
  if (portalUser) {
    redirect("/portal");
  }

  try {
    return await prisma.user.upsert({
      where: { id: authUser.id },
      update: {},
      create: {
        id: authUser.id,
        email: authUser.email!,
        name: authUser.user_metadata?.name ?? authUser.email!.split("@")[0],
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const existing = await prisma.user.findUnique({
        where: { id: authUser.id },
      });
      if (existing) {
        return existing;
      }
    }
    throw err;
  }
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFKD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-+|-+$)/g, "") || "org"
  );
}

async function uniqueOrganizationSlug(
  tx: Prisma.TransactionClient,
  base: string,
): Promise<string> {
  let candidate = base;
  let attempt = 1;
  while (await tx.organization.findUnique({ where: { slug: candidate }, select: { id: true } })) {
    attempt += 1;
    candidate = `${base}-${attempt}`;
  }
  return candidate;
}

/**
 * Resolves the organization the given user belongs to, using their OWNER
 * Membership as the source of truth (mirrors prisma/backfill-organizations.ts).
 * Users created before the multi-tenant backfill already have one; users
 * created afterwards need a personal org+membership created on the fly here,
 * so this stays idempotent and safe to call on every request.
 */
export async function getOrCreateOrganizationId(
  user: {
    id: string;
    name: string;
    email: string;
  },
  /**
   * SaaS Signup Foundation (Stage 6.1): the company name a user typed on
   * `/signup`, when this is their very first organization — takes priority
   * over the generic "${user.name}'s Workspace" default below, both for the
   * created Organization's display name and for the slug's own base text.
   * Every other caller (the lazy first-dashboard-visit path, invited users,
   * every existing test) omits this and gets byte-identical behavior to
   * before — purely additive.
   */
  preferredName?: string,
): Promise<string> {
  const ownerMembership = await prisma.membership.findFirst({
    where: { userId: user.id, role: Role.OWNER },
    select: { organizationId: true },
  });

  if (ownerMembership) {
    return ownerMembership.organizationId;
  }

  const trimmedPreferredName = preferredName?.trim();

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.membership.findFirst({
        where: { userId: user.id, role: Role.OWNER },
        select: { organizationId: true },
      });
      if (existing) {
        return existing.organizationId;
      }

      const base = slugify(trimmedPreferredName || user.name) || slugify(user.email.split("@")[0]);
      const slug = await uniqueOrganizationSlug(tx, `${base}-${user.id.slice(0, 8)}`);
      const organization = await tx.organization.create({
        data: { name: trimmedPreferredName || `${user.name}'s Workspace`, slug },
      });
      await tx.membership.create({
        data: { userId: user.id, organizationId: organization.id, role: Role.OWNER },
      });
      // Billing & Subscriptions Stage 2 (docs/billing-architecture.md §9):
      // every brand-new Organization gets a local TRIALING Subscription
      // row atomically alongside it — same transaction, so either both
      // exist or neither does.
      await createTrialSubscription(tx, organization.id, new Date());
      return organization.id;
    });
  } catch (err) {
    // Concurrent requests (e.g. prefetched pages) can race to create the
    // same user's personal org; the loser just reads back the winner's row.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.membership.findFirst({
        where: { userId: user.id, role: Role.OWNER },
        select: { organizationId: true },
      });
      if (existing) {
        return existing.organizationId;
      }
    }
    throw err;
  }
}

/**
 * Resolves which organization the current request should operate against.
 *
 * Prefers the user's explicitly chosen "active organization" — persisted in
 * an httpOnly cookie purely as a UX preference — but only after confirming a
 * Membership row proves they still belong to it; the cookie is never trusted
 * as an authorization decision by itself. Falls back to their OWNER
 * organization (auto-provisioning one via getOrCreateOrganizationId if this
 * is their first time) when no cookie is set, or when the cookie names an
 * organization they're no longer (or never were) a member of — so a user who
 * has never switched keeps working exactly as before this change.
 */
async function resolveActiveOrganizationId(user: {
  id: string;
  name: string;
  email: string;
}): Promise<string> {
  const cookieStore = await cookies();
  const requestedOrganizationId = cookieStore.get(ACTIVE_ORG_COOKIE)?.value;

  if (requestedOrganizationId) {
    const membership = await prisma.membership.findUnique({
      where: {
        userId_organizationId: { userId: user.id, organizationId: requestedOrganizationId },
      },
      select: { organizationId: true },
    });
    if (membership) {
      return membership.organizationId;
    }
  }

  const organizationId = await getOrCreateOrganizationId(user);
  try {
    // Stabilizes the resolved default for subsequent requests. Only takes
    // effect when called from a Server Action or Route Handler — thrown
    // (and ignored here) when called from a Server Component, same as the
    // Supabase cookie adapter's own setAll in lib/supabase/server.ts.
    cookieStore.set(ACTIVE_ORG_COOKIE, organizationId, activeOrgCookieOptions());
  } catch {
    // Server Component context; the cookie simply isn't written yet — the
    // next request re-resolves the same default via getOrCreateOrganizationId.
  }
  return organizationId;
}

/**
 * Convenience wrapper for the common case: pages/actions that need both the
 * current User row and the active organizationId to scope queries by.
 */
export async function getCurrentUserOrganization() {
  const user = await getOrCreateUser();
  const organizationId = await resolveActiveOrganizationId(user);
  return { user, organizationId };
}

/**
 * Like getCurrentUserOrganization(), but also resolves the current user's
 * own Membership row in the active organization — needed by anything whose
 * behavior varies by role (e.g. who's allowed to invite members). The
 * lookup can't miss: resolveActiveOrganizationId() only ever returns an
 * organizationId backed by an existing Membership for this user.
 */
export async function getCurrentMembership() {
  const { user, organizationId } = await getCurrentUserOrganization();
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: user.id, organizationId } },
  });

  if (!membership) {
    throw new Error("No membership found for the active organization.");
  }

  return { user, organizationId, membership };
}

/**
 * Switches the current user's active organization, after verifying they
 * actually hold a Membership there — callers must never set the cookie
 * directly. Must be called from a Server Action or Route Handler; cookies()
 * cannot be mutated from a Server Component.
 */
export async function setActiveOrganization(organizationId: string): Promise<void> {
  const user = await getOrCreateUser();
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: user.id, organizationId } },
    select: { organizationId: true },
  });

  if (!membership) {
    throw new Error("You are not a member of this organization.");
  }

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_ORG_COOKIE, membership.organizationId, activeOrgCookieOptions());
}

export type OrganizationSwitcherItem = {
  organizationId: string;
  name: string;
  slug: string;
  role: Role;
  isActive: boolean;
};

const ROLE_RANK: Record<Role, number> = {
  [Role.OWNER]: 0,
  [Role.ADMIN]: 1,
  [Role.MEMBER]: 2,
};

/**
 * Lists every organization the current user belongs to, for the
 * organization switcher — active organization first, then grouped by role
 * (OWNER, ADMIN, MEMBER), then alphabetically by name within each group.
 * Queried fresh on every call (no caching layer sits in front of this), so
 * a Membership removed a moment ago simply won't be in the result.
 */
export async function getOrganizationSwitcherItems(): Promise<
  OrganizationSwitcherItem[]
> {
  const { user, organizationId: activeOrganizationId } =
    await getCurrentUserOrganization();

  const memberships = await prisma.membership.findMany({
    where: { userId: user.id },
    select: {
      organizationId: true,
      role: true,
      organization: { select: { name: true, slug: true } },
    },
  });

  return memberships
    .map((m) => ({
      organizationId: m.organizationId,
      name: m.organization.name,
      slug: m.organization.slug,
      role: m.role,
      isActive: m.organizationId === activeOrganizationId,
    }))
    .sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      const roleDiff = ROLE_RANK[a.role] - ROLE_RANK[b.role];
      if (roleDiff !== 0) return roleDiff;
      return a.name.localeCompare(b.name);
    });
}
