import { bucketUnitToIntervalLiteral } from "../calculations/date-ranges";
import type { BucketUnit, ChartSeries, DualChartSeries, PrismaClientOrTx, TimeRangeBounds } from "../types";

/**
 * Analytics Stage 4. Same `generate_series` + `LEFT JOIN` + `date_trunc()`
 * shape as queries/time-series.ts (see that file's own doc comment for
 * the full safety rationale — parameterized `$queryRaw`, never the
 * "unsafe" variant). The one structural difference: `PortalUser` has no
 * `organizationId` column of its own (only `clientId`) — organization
 * scoping goes through a `Client` subquery rather than a direct column
 * match, functionally identical to the `where: { client: { organizationId
 * } } }` Prisma filter `queries/portal-metrics.ts` uses for the same
 * table.
 */
export async function getPortalUserGrowthSeries(
  client: PrismaClientOrTx,
  organizationId: string,
  bounds: TimeRangeBounds,
  unit: BucketUnit,
): Promise<ChartSeries> {
  const interval = bucketUnitToIntervalLiteral(unit);
  const rows = await client.$queryRaw<{ bucket: Date; count: number }[]>`
    SELECT bucket, COUNT(pu.id)::int AS count
    FROM generate_series(${bounds.start}::timestamptz, ${bounds.end}::timestamptz, ${interval}::interval) AS bucket
    LEFT JOIN "PortalUser" pu
      ON pu."clientId" IN (SELECT id FROM "Client" WHERE "organizationId" = ${organizationId}::uuid)
      AND date_trunc(${unit}, pu."createdAt") = date_trunc(${unit}, bucket)
    GROUP BY bucket
    ORDER BY bucket
  `;
  return { unit, points: rows.map((r) => ({ bucketStart: r.bucket, count: r.count })) };
}

/**
 * "sent" reuses `DualChartSeries.created`, "accepted" reuses `.completed`
 * — see types.ts's own doc comment on `portalInvitationSeries` for why:
 * this lets the exact same `ActivityStackedBarChart` component Stage 3
 * built for Task/Invoice activity render this series too, with only a
 * label change at the call site, never a new chart component.
 *
 * Both counts come from `Activity.action` (`PORTAL_INVITATION_SENT`/
 * `PORTAL_INVITATION_ACCEPTED`) — real, existing event rows the app
 * already writes for its own portal-invite flow (src/app/(dashboard)/
 * clients/[id]/edit/portal-access-actions.ts and src/app/portal/invite/
 * [token]/actions.ts), never a new tracking table.
 */
export async function getPortalInvitationSeries(
  client: PrismaClientOrTx,
  organizationId: string,
  bounds: TimeRangeBounds,
  unit: BucketUnit,
): Promise<DualChartSeries> {
  const interval = bucketUnitToIntervalLiteral(unit);
  const rows = await client.$queryRaw<{ bucket: Date; sent: number; accepted: number }[]>`
    SELECT
      bucket,
      COUNT(DISTINCT sent_a.id)::int AS sent,
      COUNT(DISTINCT accepted_a.id)::int AS accepted
    FROM generate_series(${bounds.start}::timestamptz, ${bounds.end}::timestamptz, ${interval}::interval) AS bucket
    LEFT JOIN "Activity" sent_a
      ON sent_a."organizationId" = ${organizationId}::uuid
      AND sent_a.action = 'PORTAL_INVITATION_SENT'::"ActivityAction"
      AND date_trunc(${unit}, sent_a."createdAt") = date_trunc(${unit}, bucket)
    LEFT JOIN "Activity" accepted_a
      ON accepted_a."organizationId" = ${organizationId}::uuid
      AND accepted_a.action = 'PORTAL_INVITATION_ACCEPTED'::"ActivityAction"
      AND date_trunc(${unit}, accepted_a."createdAt") = date_trunc(${unit}, bucket)
    GROUP BY bucket
    ORDER BY bucket
  `;
  return { unit, points: rows.map((r) => ({ bucketStart: r.bucket, created: r.sent, completed: r.accepted })) };
}
