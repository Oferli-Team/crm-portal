import { prisma } from "@/lib/prisma";
import type { Role } from "@/generated/prisma/enums";
import { getCompanyProfile, type CompanyProfileData } from "@/lib/organization-setup/company-profile";
import { getOrganizationEntitlements, type OrganizationEntitlements } from "@/lib/billing/entitlements";
import { getPlan } from "@/lib/billing/plans";
import { formatActivity, type ActivityDisplayModel } from "@/lib/activity/format-activity";
import { classifyOrganizationLifecycle, type OrganizationLifecycleStatus } from "./organizations";
import type { SubscriptionStateInput } from "@/lib/billing/access-mode";

const RECENT_ACTIVITY_TAKE = 15;
const PREVIEW_TAKE = 10;

const CLIENT_INVITATION_STATUSES = ["PENDING", "ACCEPTED", "REVOKED", "EXPIRED"] as const;

export type OrganizationDetailHeader = {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
};

export type OrganizationStaffMember = {
  id: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: Date;
};

export type OrganizationEntityPreview = {
  id: string;
  name: string;
  status: string;
  createdAt: Date;
};

export type PortalStatistics = {
  portalUsersCount: number;
  invitationsByStatus: Record<(typeof CLIENT_INVITATION_STATUSES)[number], number>;
};

export type OrganizationOwner = {
  id: string;
  name: string;
  email: string;
};

export type OrganizationDetail = {
  organization: OrganizationDetailHeader;
  /** Business Identity section — reused verbatim from company-profile.ts, already organizationId-parameterized and "any member may view" (a strictly less privileged read than this). */
  businessIdentity: CompanyProfileData;
  /**
   * Subscription AND (entitlement-vs-limit) Usage — both come from this
   * one call. getOrganizationEntitlements() already returns
   * subscriptionStatus/accessMode/trialEndsAt/gracePeriodEndsAt
   * alongside currentMembers/currentClients/currentProjects/
   * currentStorageBytes against the plan's own limits — no reason to
   * call it twice or reimplement either half.
   */
  entitlements: OrganizationEntitlements;
  /** Human-readable plan name for entitlements.planKey — getPlan() is a pure, in-memory catalog lookup, not a second query. */
  planDisplayName: string;
  /**
   * The one lifecycle field getOrganizationEntitlements() doesn't expose
   * (it returns the raw SubscriptionStatus, not the 7-bucket business
   * classification) — computed via the exact same classifyOrganizationLifecycle()
   * the Organization Explorer list (organizations.ts) already uses, from
   * a single small raw Subscription read this file needs anyway for
   * trialStartedAt (below) — never a second definition of "lifecycle."
   */
  lifecycleStatus: OrganizationLifecycleStatus;
  /** Not part of OrganizationEntitlements' own return shape — read from the same raw Subscription row lifecycleStatus is computed from, at no extra query cost. Null for a legacy org (no Subscription row) or one that was never on a trial. */
  trialStartedAt: Date | null;
  /** Derived from `staff` below (role === OWNER) — zero extra queries, same organization every membership already belongs to. Null only if an organization somehow has no OWNER membership (shouldn't happen given this app's own invariants, but never assumed). */
  owner: OrganizationOwner | null;
  recentActivity: { id: string; display: ActivityDisplayModel }[];
  staff: OrganizationStaffMember[];
  projects: { preview: OrganizationEntityPreview[]; total: number };
  clients: { preview: OrganizationEntityPreview[]; total: number };
  /** Standalone Usage section (Clients/Projects/Tasks totals) — distinct from entitlements' own usage-vs-limits comparison above. clients.total/projects.total are already fetched; tasksTotal is the one genuinely new count this section needs. */
  tasksTotal: number;
  portalStatistics: PortalStatistics;
};

/**
 * Sale-Ready Phase C, PR3.1/PR3.3 (Organization Explorer — approved
 * plan, §5). One organization, every read unscoped by any session — the
 * caller (the /platform-admin/organizations/[id] page) is the only place
 * requirePlatformAdmin() needs to run; this function just takes whichever
 * organizationId the URL names. Returns null for an organizationId that
 * doesn't exist, so the page can render a real 404 rather than crash.
 */
export async function getOrganizationDetail(organizationId: string, now: Date): Promise<OrganizationDetail | null> {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true, slug: true, createdAt: true },
  });
  if (!organization) return null;

  const [
    businessIdentity,
    entitlements,
    rawSubscription,
    activityRows,
    staffRows,
    projectRows,
    projectsTotal,
    clientRows,
    clientsTotal,
    tasksTotal,
    portalUsersCount,
    invitationGroups,
  ] = await Promise.all([
    getCompanyProfile(organizationId),
    getOrganizationEntitlements(organizationId, { now }),
    // getOrganizationEntitlements() already reads a Subscription row
    // internally, but doesn't expose trialStartedAt or a form
    // classifyOrganizationLifecycle() can consume directly — this one
    // small, targeted read (a single row by its own unique index) serves
    // both, rather than either reimplementing lifecycle classification or
    // leaving "Trial start" unshown.
    prisma.subscription.findUnique({
      where: { organizationId },
      select: { status: true, trialStartedAt: true, trialEndsAt: true, currentPeriodEnd: true, gracePeriodEndsAt: true },
    }),
    prisma.activity.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: RECENT_ACTIVITY_TAKE,
      include: { actor: { select: { name: true, email: true } } },
    }),
    prisma.membership.findMany({
      where: { organizationId },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
    prisma.project.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: PREVIEW_TAKE,
      select: { id: true, name: true, status: true, createdAt: true },
    }),
    prisma.project.count({ where: { organizationId } }),
    prisma.client.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: PREVIEW_TAKE,
      select: { id: true, name: true, status: true, createdAt: true },
    }),
    prisma.client.count({ where: { organizationId } }),
    prisma.task.count({ where: { organizationId } }),
    prisma.portalUser.count({ where: { client: { organizationId } } }),
    prisma.clientInvitation.groupBy({
      by: ["status"],
      where: { client: { organizationId } },
      _count: true,
    }),
  ]);

  const invitationCounts = new Map(invitationGroups.map((group) => [group.status, group._count]));
  const invitationsByStatus = Object.fromEntries(
    CLIENT_INVITATION_STATUSES.map((status) => [status, invitationCounts.get(status) ?? 0]),
  ) as PortalStatistics["invitationsByStatus"];

  const subscriptionInput: SubscriptionStateInput | null = rawSubscription
    ? {
        status: rawSubscription.status,
        trialEndsAt: rawSubscription.trialEndsAt,
        currentPeriodEnd: rawSubscription.currentPeriodEnd,
        gracePeriodEndsAt: rawSubscription.gracePeriodEndsAt,
      }
    : null;

  const ownerMembership = staffRows.find((row) => row.role === "OWNER");

  return {
    organization,
    businessIdentity,
    entitlements,
    planDisplayName: getPlan(entitlements.planKey).displayName,
    lifecycleStatus: classifyOrganizationLifecycle(subscriptionInput, now),
    trialStartedAt: rawSubscription?.trialStartedAt ?? null,
    owner: ownerMembership
      ? { id: ownerMembership.user.id, name: ownerMembership.user.name, email: ownerMembership.user.email }
      : null,
    tasksTotal,
    recentActivity: activityRows.map((row) => ({
      id: row.id,
      display: formatActivity({
        entityType: row.entityType,
        action: row.action,
        metadata: row.metadata,
        actor: row.actor,
        createdAt: row.createdAt,
      }),
    })),
    staff: staffRows.map((row) => ({
      id: row.user.id,
      name: row.user.name,
      email: row.user.email,
      role: row.role,
      joinedAt: row.createdAt,
    })),
    projects: { preview: projectRows, total: projectsTotal },
    clients: { preview: clientRows, total: clientsTotal },
    portalStatistics: { portalUsersCount, invitationsByStatus },
  };
}
