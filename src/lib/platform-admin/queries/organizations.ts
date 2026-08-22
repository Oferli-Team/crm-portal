import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  computeAccessMode,
  LEGACY_ACCESS_MODE,
  type AccessMode,
  type SubscriptionStateInput,
} from "@/lib/billing/access-mode";
import {
  PAGE_SIZE,
  getOffset,
  parseSearchParam,
  parsePageParam,
  parseEnumParam,
  parseSortParam,
  type RawSearchParams,
} from "@/lib/list-params";

export const ORGANIZATION_LIFECYCLE_STATUSES = [
  "TRIAL",
  "PAID",
  "EXPIRED",
  "SUSPENDED",
  "CANCELED",
  "LEGACY",
  "ARCHIVED",
] as const;

export type OrganizationLifecycleStatus = (typeof ORGANIZATION_LIFECYCLE_STATUSES)[number];

/**
 * Sale-Ready Phase C, PR3.1 (Organization Explorer — approved architecture,
 * see the Phase C, PR3 plan). Classifies a Subscription's real-world
 * business state for the Platform Admin list/filter UI — never a second
 * definition of *access*, which stays exactly computeAccessMode()'s job.
 * This function only decides which of the seven business-facing buckets a
 * given (status, accessMode) combination belongs to.
 *
 * `null` (no Subscription row at all) is its own LEGACY bucket, never
 * folded into PAID — a legacy org has never been through a real checkout
 * and isn't a paying customer; conflating the two would overstate
 * revenue-bearing accounts in a tool whose whole purpose is truthful
 * business metrics (explicit product decision, not a default).
 *
 * CANCELED (lapsed) is kept distinct from SUSPENDED (payment failure)
 * rather than collapsed into one bucket: the data model already
 * distinguishes them — CANCELED is its own SubscriptionStatus, with
 * dedicated cancelAtPeriodEnd/canceledAt tracking no payment-failure path
 * has — so reporting them as indistinguishable would misstate a
 * distinction this schema actually preserves.
 *
 * ARCHIVED is never returned today — no deletedAt/archived concept exists
 * anywhere in this schema. It exists in this type only so the filter UI
 * can expose it (as required — "future-proof"), and so a future PR that
 * adds real archiving only needs one new early-return branch here, not a
 * new type this function's every caller would otherwise need to learn
 * about.
 */
export function classifyOrganizationLifecycle(
  subscription: SubscriptionStateInput | null,
  now: Date,
): OrganizationLifecycleStatus {
  if (!subscription) return "LEGACY";

  const accessMode = computeAccessMode(subscription, now);

  switch (subscription.status) {
    case "TRIALING":
      return accessMode === "FULL_ACCESS" ? "TRIAL" : "EXPIRED";
    case "ACTIVE":
      return "PAID";
    case "PAST_DUE":
      return accessMode === "FULL_ACCESS" ? "PAID" : "SUSPENDED";
    case "UNPAID":
      return "SUSPENDED";
    case "CANCELED":
      return accessMode === "FULL_ACCESS" ? "PAID" : "CANCELED";
    case "INCOMPLETE":
      // Never actually produced by any code path today — no real checkout
      // exists yet (see computeAccessMode's own comment on this branch).
      // Kept only so this switch stays exhaustive against the full
      // SubscriptionStatus enum.
      return "PAID";
    default: {
      const exhaustive: never = subscription.status;
      throw new Error(`Unhandled SubscriptionStatus: ${String(exhaustive)}`);
    }
  }
}

export const ORGANIZATION_SORT_FIELDS = ["createdAt", "name"] as const;
export type OrganizationSortField = (typeof ORGANIZATION_SORT_FIELDS)[number];

export type OrganizationListParams = {
  q: string;
  status?: OrganizationLifecycleStatus;
  sortField: OrganizationSortField;
  sortDir: "asc" | "desc";
  sortCombined: string;
  page: number;
};

export function parseOrganizationListParams(searchParams: RawSearchParams): OrganizationListParams {
  const q = parseSearchParam(searchParams.q);
  const status = parseEnumParam(searchParams.status, ORGANIZATION_LIFECYCLE_STATUSES);
  const { field, dir, combined } = parseSortParam(searchParams.sort, ORGANIZATION_SORT_FIELDS, "createdAt:desc");
  const page = parsePageParam(searchParams.page);

  return { q, status, sortField: field, sortDir: dir, sortCombined: combined, page };
}

/**
 * Translates one lifecycle bucket into a Subscription WHERE clause —
 * mirrors classifyOrganizationLifecycle's own branches exactly (each
 * bucket here is that function's inverse for the corresponding case), so
 * filtering by a bucket and classifying a row into that same bucket can
 * never disagree. Entirely expressible in Prisma — no raw SQL, matching
 * every other list page's own search/filter shape in this codebase.
 */
function buildLifecycleWhere(status: OrganizationLifecycleStatus, now: Date): Prisma.OrganizationWhereInput {
  switch (status) {
    case "TRIAL":
      return { subscription: { status: "TRIALING", trialEndsAt: { gte: now } } };
    case "EXPIRED":
      return { subscription: { status: "TRIALING", trialEndsAt: { lt: now } } };
    case "PAID":
      return {
        subscription: {
          OR: [
            { status: "ACTIVE" },
            { status: "INCOMPLETE" },
            { status: "PAST_DUE", gracePeriodEndsAt: { gte: now } },
            { status: "CANCELED", currentPeriodEnd: { gte: now } },
          ],
        },
      };
    case "SUSPENDED":
      return {
        subscription: {
          OR: [
            { status: "UNPAID" },
            { status: "PAST_DUE", OR: [{ gracePeriodEndsAt: null }, { gracePeriodEndsAt: { lt: now } }] },
          ],
        },
      };
    case "CANCELED":
      return {
        subscription: {
          status: "CANCELED",
          OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { lt: now } }],
        },
      };
    case "LEGACY":
      return { subscription: null };
    case "ARCHIVED":
      // Never matches anything today — no archived concept exists in this
      // schema (see classifyOrganizationLifecycle's own doc comment).
      // Deliberately an always-empty result, not a disabled filter option:
      // the UI should tell the truth ("no results") rather than imply
      // "coming soon."
      return { id: { in: [] } };
    default: {
      const exhaustive: never = status;
      throw new Error(`Unhandled OrganizationLifecycleStatus: ${String(exhaustive)}`);
    }
  }
}

export function buildOrganizationWhere(
  { q, status }: Pick<OrganizationListParams, "q" | "status">,
  now: Date,
): Prisma.OrganizationWhereInput {
  return {
    ...(status ? buildLifecycleWhere(status, now) : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { slug: { contains: q, mode: "insensitive" as const } },
            { memberships: { some: { role: "OWNER" as const, user: { email: { contains: q, mode: "insensitive" as const } } } } },
          ],
        }
      : {}),
  };
}

export function buildOrganizationOrderBy(
  params: Pick<OrganizationListParams, "sortField" | "sortDir">,
): Prisma.OrganizationOrderByWithRelationInput {
  return { [params.sortField]: params.sortDir };
}

export type OrganizationListRow = {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  owner: { name: string; email: string } | null;
  lifecycleStatus: OrganizationLifecycleStatus;
  accessMode: AccessMode;
  staffCount: number;
  clientsCount: number;
  projectsCount: number;
  portalUsersCount: number;
};

/**
 * Portal users are two relation hops from Organization
 * (Organization -> Client -> PortalUser), so Prisma's `_count` can't fold
 * this into the same findMany() the way staff/clients/projects counts
 * are — those are direct relations. One extra page-scoped query (never
 * per-row) covers the whole page: fetch every Client for the page's
 * organizations with its own portalUsers _count, then sum in memory per
 * organizationId.
 */
async function getPortalUserCountsByOrganization(organizationIds: string[]): Promise<Map<string, number>> {
  if (organizationIds.length === 0) return new Map();

  const clients = await prisma.client.findMany({
    where: { organizationId: { in: organizationIds } },
    select: { organizationId: true, _count: { select: { portalUsers: true } } },
  });

  const counts = new Map<string, number>();
  for (const client of clients) {
    if (!client.organizationId) continue;
    counts.set(client.organizationId, (counts.get(client.organizationId) ?? 0) + client._count.portalUsers);
  }
  return counts;
}

/**
 * The Organization Explorer list — one bulk query per page (plus the one
 * portal-count query above), never getOrganizationEntitlements() per row
 * (that function is correctly reused as-is on the *detail* page — see
 * organization-detail.ts — but calling it once per list row would be
 * N+1: a Subscription lookup plus four usage aggregates plus a pending-
 * invitations count, times PAGE_SIZE). Subscription is included directly
 * and classified in memory via the same computeAccessMode() the detail
 * page and billing enforcement already use, so list and detail can never
 * disagree about what a given org's access mode is.
 */
export async function listOrganizations(
  params: OrganizationListParams,
  now: Date,
): Promise<{ organizations: OrganizationListRow[]; total: number }> {
  const where = buildOrganizationWhere(params, now);
  const orderBy = buildOrganizationOrderBy(params);

  const [rows, total] = await prisma.$transaction([
    prisma.organization.findMany({
      where,
      orderBy,
      skip: getOffset(params.page),
      take: PAGE_SIZE,
      include: {
        subscription: true,
        memberships: {
          where: { role: "OWNER" },
          take: 1,
          include: { user: { select: { name: true, email: true } } },
        },
        _count: { select: { memberships: true, clients: true, projects: true } },
      },
    }),
    prisma.organization.count({ where }),
  ]);

  const portalCounts = await getPortalUserCountsByOrganization(rows.map((row) => row.id));

  const organizations: OrganizationListRow[] = rows.map((row) => {
    const subscriptionInput: SubscriptionStateInput | null = row.subscription
      ? {
          status: row.subscription.status,
          trialEndsAt: row.subscription.trialEndsAt,
          currentPeriodEnd: row.subscription.currentPeriodEnd,
          gracePeriodEndsAt: row.subscription.gracePeriodEndsAt,
        }
      : null;

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      createdAt: row.createdAt,
      owner: row.memberships[0]?.user ?? null,
      lifecycleStatus: classifyOrganizationLifecycle(subscriptionInput, now),
      accessMode: subscriptionInput ? computeAccessMode(subscriptionInput, now) : LEGACY_ACCESS_MODE,
      staffCount: row._count.memberships,
      clientsCount: row._count.clients,
      projectsCount: row._count.projects,
      portalUsersCount: portalCounts.get(row.id) ?? 0,
    };
  });

  return { organizations, total };
}
