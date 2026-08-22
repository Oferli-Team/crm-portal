import { prisma } from "@/lib/prisma";
import { computeAccessMode, type SubscriptionStateInput } from "@/lib/billing/access-mode";

export type PlatformDashboardKpis = {
  organizations: number;
  activeTrials: number;
  expiredTrials: number;
  activeSubscriptions: number;
  staffUsers: number;
  portalUsers: number;
  clients: number;
  projects: number;
  tasks: number;
};

export type PlatformDashboardRegistrations = {
  today: number;
  last7Days: number;
};

export type NewestOrganization = {
  id: string;
  name: string;
  createdAt: Date;
};

export type PlatformDashboardData = {
  kpis: PlatformDashboardKpis;
  registrations: PlatformDashboardRegistrations;
  newestOrganizations: NewestOrganization[];
};

const NEWEST_ORGANIZATIONS_TAKE = 10;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * UTC calendar-day boundary — a platform-wide metric has no single
 * "local" timezone to anchor to (tenants span every timezone), so UTC is
 * the one unambiguous choice, matching how every other server-computed
 * timestamp in this app is already UTC.
 */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Classifies each TRIALING subscription via computeAccessMode() — the
 * exact same pure function billing enforcement already uses — rather than
 * reimplementing the trialEndsAt boundary as a second, parallel
 * inequality that could quietly drift from it. This is the one KPI too
 * small to express as a single Prisma count(): computeAccessMode takes a
 * whole subscription's state, so classifying "active vs. expired" means
 * loading the (today: tiny) set of TRIALING rows and running it per row.
 */
export function countActiveAndExpiredTrials(
  trialingSubscriptions: SubscriptionStateInput[],
  now: Date,
): { active: number; expired: number } {
  let active = 0;
  for (const subscription of trialingSubscriptions) {
    if (computeAccessMode(subscription, now) === "FULL_ACCESS") {
      active += 1;
    }
  }
  return { active, expired: trialingSubscriptions.length - active };
}

/**
 * Sale-Ready Phase C, PR2. Every field is a deliberately unscoped,
 * cross-organization read — see src/lib/platform-admin/authorization.ts
 * for why that's the entire point of this module, and
 * check-platform-admin-security.mjs for the check that keeps it that way.
 * One Promise.all, same shape as (dashboard)/dashboard/query.ts's own
 * getDashboardAnalytics.
 */
export async function getPlatformDashboardData(now: Date): Promise<PlatformDashboardData> {
  const todayStart = startOfUtcDay(now);
  const sevenDaysAgo = new Date(now.getTime() - SEVEN_DAYS_MS);

  const [
    organizations,
    trialingSubscriptions,
    activeSubscriptions,
    staffUsers,
    portalUsers,
    clients,
    projects,
    tasks,
    registrationsToday,
    registrationsLast7Days,
    newestOrganizations,
  ] = await Promise.all([
    prisma.organization.count(),
    prisma.subscription.findMany({
      where: { status: "TRIALING" },
      select: { status: true, trialEndsAt: true, currentPeriodEnd: true, gracePeriodEndsAt: true },
    }),
    prisma.subscription.count({ where: { status: "ACTIVE" } }),
    prisma.user.count(),
    prisma.portalUser.count(),
    prisma.client.count(),
    prisma.project.count(),
    prisma.task.count(),
    prisma.organization.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.organization.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    prisma.organization.findMany({
      orderBy: { createdAt: "desc" },
      take: NEWEST_ORGANIZATIONS_TAKE,
      select: { id: true, name: true, createdAt: true },
    }),
  ]);

  const { active: activeTrials, expired: expiredTrials } = countActiveAndExpiredTrials(trialingSubscriptions, now);

  return {
    kpis: {
      organizations,
      activeTrials,
      expiredTrials,
      activeSubscriptions,
      staffUsers,
      portalUsers,
      clients,
      projects,
      tasks,
    },
    registrations: { today: registrationsToday, last7Days: registrationsLast7Days },
    newestOrganizations,
  };
}
