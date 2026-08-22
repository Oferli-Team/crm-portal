import { calculateGrowthRate } from "../calculations/rates";
import type { GrowthMetric, PortalMetrics, PrismaClientOrTx, TimeRangeBounds } from "../types";

/**
 * Analytics Stage 4 (docs/analytics-architecture.md §13). Every count here
 * is derived from PortalUser/Client/Project/Attachment/Invoice/Activity —
 * the task's own allowed source list — and nothing is read from
 * PortalUser beyond `id`/`clientId` (never `email`/`name`, so this file
 * can never be the place a portal contact's PII leaks into an aggregate).
 *
 * No `findMany` of full rows anywhere below — `clientIdsWithPortalAccess`
 * and `projectIdsForThosePClients` (sic: portalClients) select `id` only,
 * and every count that follows is a bounded, indexed `count`/`in` filter.
 * This is a fixed handful of sequential-but-cheap lookups (never per-row
 * looping — the classic N+1 shape), the same "several small queries,
 * never a giant join" tradeoff `usage.ts` already makes elsewhere in this
 * codebase, chosen here for auditability over a single denser raw query.
 */
export async function getPortalOverview(
  client: PrismaClientOrTx,
  organizationId: string,
): Promise<Pick<PortalMetrics, "totalPortalUsers" | "portalAdoptionRate" | "documentsAvailable" | "invoicesVisible">> {
  const [totalPortalUsers, totalClients, clientsWithPortalAccess] = await Promise.all([
    client.portalUser.count({ where: { client: { organizationId } } }),
    client.client.count({ where: { organizationId } }),
    client.client.findMany({ where: { organizationId, portalUsers: { some: {} } }, select: { id: true } }),
  ]);

  const clientIdsWithPortalAccess = clientsWithPortalAccess.map((c) => c.id);

  const [projectsForThoseClients, invoicesVisible] = await Promise.all([
    clientIdsWithPortalAccess.length > 0
      ? client.project.findMany({ where: { clientId: { in: clientIdsWithPortalAccess } }, select: { id: true } })
      : Promise.resolve([]),
    clientIdsWithPortalAccess.length > 0
      ? client.invoice.count({ where: { clientId: { in: clientIdsWithPortalAccess } } })
      : Promise.resolve(0),
  ]);
  const projectIdsForThoseClients = projectsForThoseClients.map((p) => p.id);

  const [clientLevelAttachments, projectLevelAttachments] = await Promise.all([
    clientIdsWithPortalAccess.length > 0
      ? client.attachment.count({ where: { organizationId, entityType: "CLIENT", entityId: { in: clientIdsWithPortalAccess } } })
      : Promise.resolve(0),
    projectIdsForThoseClients.length > 0
      ? client.attachment.count({ where: { organizationId, entityType: "PROJECT", entityId: { in: projectIdsForThoseClients } } })
      : Promise.resolve(0),
  ]);

  return {
    totalPortalUsers,
    portalAdoptionRate: totalClients <= 0 ? 0 : Math.round((clientIdsWithPortalAccess.length / totalClients) * 100),
    documentsAvailable: clientLevelAttachments + projectLevelAttachments,
    invoicesVisible,
  };
}

/**
 * "Invitation acceptance count" and "completed actions"/"recent activity
 * count" (docs/analytics-architecture.md §13) — both real, time-boundable
 * counts against Activity, the app's own existing event log for exactly
 * this kind of question. `PORTAL_INVITATION_ACCEPTED` is written exactly
 * once per real acceptance (src/app/portal/invite/[token]/actions.ts,
 * inside the same transaction as the PortalUser upsert) — never inferred,
 * never approximated.
 */
export async function getPortalActivityCounts(
  client: PrismaClientOrTx,
  organizationId: string,
  bounds: TimeRangeBounds,
  previousBounds: TimeRangeBounds,
): Promise<{ invitationsAccepted: GrowthMetric; portalRelatedActivity: number }> {
  const acceptedWhere = (b: TimeRangeBounds) => ({
    organizationId,
    action: "PORTAL_INVITATION_ACCEPTED" as const,
    createdAt: { ...(b.start ? { gte: b.start } : {}), lte: b.end },
  });

  const [acceptedCurrent, acceptedPrevious, portalRelatedActivity] = await Promise.all([
    client.activity.count({ where: acceptedWhere(bounds) }),
    client.activity.count({ where: acceptedWhere(previousBounds) }),
    client.activity.count({
      where: {
        organizationId,
        entityType: "PORTAL_USER",
        createdAt: { ...(bounds.start ? { gte: bounds.start } : {}), lte: bounds.end },
      },
    }),
  ]);

  return {
    invitationsAccepted: {
      currentPeriodCount: acceptedCurrent,
      previousPeriodCount: acceptedPrevious,
      changePercent: calculateGrowthRate(acceptedCurrent, acceptedPrevious),
    },
    portalRelatedActivity,
  };
}

/**
 * Portal Analytics read path Slice 2 (docs/analytics-architecture.md
 * §12.2b; persisted by Slice 1, §12.2a/§12.3) — the read side of the
 * persistence Slice 1 added. Both fields are plain, current-selected-range
 * scalar counts, never `GrowthMetric`s: `recentlyActivePortalUsers` is
 * derived from `PortalUser.lastLoginAt`, a single mutable timestamp with no
 * previous-period history to honestly compare against (a later sign-in
 * overwrites the only evidence of an earlier one); `documentDownloadRequests`
 * counts immutable `PortalDownloadRequest` rows, which *could* support a
 * previous-period comparison, but none is built here — see §12.2b for the
 * full reasoning behind keeping both plain scalars in this pass.
 *
 * `bounds` must be the **literal** selected-`TimeRange` bounds
 * (`getTimeRangeBounds(timeRange, now)`, called directly — never the
 * growth-comparison-substituted `growthBounds` `getPortalActivityCounts`
 * above receives) — a true `allTime` (`bounds.start === null`) must
 * really mean "since the beginning of time," not silently fall back to
 * `DEFAULT_GROWTH_TIME_RANGE`. Both filters use this domain's half-open
 * `[start, end)` convention (`gte` on the inclusive start, `lt` on the
 * exclusive end, `gte` entirely omitted when `start` is null) — the
 * correct convention already established by `queries/growth-metrics.ts`,
 * deliberately not `getPortalActivityCounts`'s own pre-existing `lte`
 * convention above, which is a separate, out-of-scope, unrelated
 * boundary behavior this function does not repeat and does not repair.
 *
 * Two independent `count` queries only — no `findMany`, no raw SQL, no
 * row materialization, no per-row loop, no PII of any kind (`PortalUser`
 * is never read beyond the bare count; `PortalDownloadRequest` has no PII
 * to read in the first place).
 */
export async function getPortalEngagementCounts(
  client: PrismaClientOrTx,
  organizationId: string,
  bounds: TimeRangeBounds,
): Promise<Pick<PortalMetrics, "recentlyActivePortalUsers" | "documentDownloadRequests">> {
  const [recentlyActivePortalUsers, documentDownloadRequests] = await Promise.all([
    client.portalUser.count({
      where: {
        client: { organizationId },
        lastLoginAt: { ...(bounds.start ? { gte: bounds.start } : {}), lt: bounds.end },
      },
    }),
    client.portalDownloadRequest.count({
      where: {
        organizationId,
        requestedAt: { ...(bounds.start ? { gte: bounds.start } : {}), lt: bounds.end },
      },
    }),
  ]);

  return { recentlyActivePortalUsers, documentDownloadRequests };
}
