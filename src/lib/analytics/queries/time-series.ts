import { bucketUnitToIntervalLiteral } from "../calculations/date-ranges";
import type { BucketUnit, ChartSeries, DualChartSeries, PrismaClientOrTx, TimeRangeBounds } from "../types";

/**
 * Analytics Stage 3 (docs/analytics-architecture.md §10). Every series is
 * exactly one aggregate query — `generate_series()` produces every bucket
 * in the window up front (so a day/hour/week with zero activity still
 * appears as a real `0` point, never a gap a line chart would silently
 * skip), `LEFT JOIN`ed against the real rows and `date_trunc()`-grouped.
 * Never the raw-string-interpolating "unsafe" query variant — every
 * interpolated value here is a bound parameter (organizationId, the
 * window bounds, the unit strings), never string-concatenated; only the
 * table/column names are literal SQL text this file itself writes, never
 * a runtime value.
 *
 * `unit` is passed to Postgres's own `date_trunc(text, ...)` as a plain
 * bound text parameter — safe (it's a function argument, not an
 * identifier), and always one of `"hour"`/`"day"`/`"week"` from
 * `getBucketUnit()`, never raw user input.
 */
function toSeriesPoints(rows: { bucket: Date; count: number }[]): { bucketStart: Date; count: number }[] {
  return rows.map((r) => ({ bucketStart: r.bucket, count: r.count }));
}

export async function getClientGrowthSeries(
  client: PrismaClientOrTx,
  organizationId: string,
  bounds: TimeRangeBounds,
  unit: BucketUnit,
): Promise<ChartSeries> {
  const interval = bucketUnitToIntervalLiteral(unit);
  const rows = await client.$queryRaw<{ bucket: Date; count: number }[]>`
    SELECT bucket, COUNT(c.id)::int AS count
    FROM generate_series(${bounds.start}::timestamptz, ${bounds.end}::timestamptz, ${interval}::interval) AS bucket
    LEFT JOIN "Client" c
      ON c."organizationId" = ${organizationId}::uuid
      AND date_trunc(${unit}, c."createdAt") = date_trunc(${unit}, bucket)
    GROUP BY bucket
    ORDER BY bucket
  `;
  return { unit, points: toSeriesPoints(rows) };
}

export async function getProjectGrowthSeries(
  client: PrismaClientOrTx,
  organizationId: string,
  bounds: TimeRangeBounds,
  unit: BucketUnit,
): Promise<ChartSeries> {
  const interval = bucketUnitToIntervalLiteral(unit);
  const rows = await client.$queryRaw<{ bucket: Date; count: number }[]>`
    SELECT bucket, COUNT(p.id)::int AS count
    FROM generate_series(${bounds.start}::timestamptz, ${bounds.end}::timestamptz, ${interval}::interval) AS bucket
    LEFT JOIN "Project" p
      ON p."organizationId" = ${organizationId}::uuid
      AND date_trunc(${unit}, p."createdAt") = date_trunc(${unit}, bucket)
    GROUP BY bucket
    ORDER BY bucket
  `;
  return { unit, points: toSeriesPoints(rows) };
}

export async function getActivityEventsSeries(
  client: PrismaClientOrTx,
  organizationId: string,
  bounds: TimeRangeBounds,
  unit: BucketUnit,
): Promise<ChartSeries> {
  const interval = bucketUnitToIntervalLiteral(unit);
  const rows = await client.$queryRaw<{ bucket: Date; count: number }[]>`
    SELECT bucket, COUNT(a.id)::int AS count
    FROM generate_series(${bounds.start}::timestamptz, ${bounds.end}::timestamptz, ${interval}::interval) AS bucket
    LEFT JOIN "Activity" a
      ON a."organizationId" = ${organizationId}::uuid
      AND date_trunc(${unit}, a."createdAt") = date_trunc(${unit}, bucket)
    GROUP BY bucket
    ORDER BY bucket
  `;
  return { unit, points: toSeriesPoints(rows) };
}

/**
 * "Created" is bucketed on `Task.createdAt`; "completed" is bucketed on
 * `Task.completedAt` — two independent counts per bucket (a task
 * completed in a bucket need not have been created in that same bucket),
 * combined with a `FULL OUTER JOIN`-free approach: both counts are
 * computed against the same `generate_series` backbone via two separate
 * `LEFT JOIN`s in one query, never two round-trips.
 */
export async function getTaskActivitySeries(
  client: PrismaClientOrTx,
  organizationId: string,
  bounds: TimeRangeBounds,
  unit: BucketUnit,
): Promise<DualChartSeries> {
  const interval = bucketUnitToIntervalLiteral(unit);
  const rows = await client.$queryRaw<{ bucket: Date; created: number; completed: number }[]>`
    SELECT
      bucket,
      COUNT(DISTINCT created_t.id)::int AS created,
      COUNT(DISTINCT completed_t.id)::int AS completed
    FROM generate_series(${bounds.start}::timestamptz, ${bounds.end}::timestamptz, ${interval}::interval) AS bucket
    LEFT JOIN "Task" created_t
      ON created_t."organizationId" = ${organizationId}::uuid
      AND date_trunc(${unit}, created_t."createdAt") = date_trunc(${unit}, bucket)
    LEFT JOIN "Task" completed_t
      ON completed_t."organizationId" = ${organizationId}::uuid
      AND completed_t."completedAt" IS NOT NULL
      AND date_trunc(${unit}, completed_t."completedAt") = date_trunc(${unit}, bucket)
    GROUP BY bucket
    ORDER BY bucket
  `;
  return { unit, points: rows.map((r) => ({ bucketStart: r.bucket, created: r.created, completed: r.completed })) };
}

/** Same shape as `getTaskActivitySeries`, using `Invoice.createdAt`/`Invoice.paidAt` — "completed" means paid, matching queries/completion-metrics.ts's own definition. */
export async function getInvoiceActivitySeries(
  client: PrismaClientOrTx,
  organizationId: string,
  bounds: TimeRangeBounds,
  unit: BucketUnit,
): Promise<DualChartSeries> {
  const interval = bucketUnitToIntervalLiteral(unit);
  const rows = await client.$queryRaw<{ bucket: Date; created: number; completed: number }[]>`
    SELECT
      bucket,
      COUNT(DISTINCT created_i.id)::int AS created,
      COUNT(DISTINCT paid_i.id)::int AS completed
    FROM generate_series(${bounds.start}::timestamptz, ${bounds.end}::timestamptz, ${interval}::interval) AS bucket
    LEFT JOIN "Invoice" created_i
      ON created_i."organizationId" = ${organizationId}::uuid
      AND date_trunc(${unit}, created_i."createdAt") = date_trunc(${unit}, bucket)
    LEFT JOIN "Invoice" paid_i
      ON paid_i."organizationId" = ${organizationId}::uuid
      AND paid_i."paidAt" IS NOT NULL
      AND date_trunc(${unit}, paid_i."paidAt") = date_trunc(${unit}, bucket)
    GROUP BY bucket
    ORDER BY bucket
  `;
  return { unit, points: rows.map((r) => ({ bucketStart: r.bucket, created: r.created, completed: r.completed })) };
}
