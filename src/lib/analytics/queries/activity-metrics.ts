import { getCalendarBoundaries } from "../calculations/date-ranges";
import type { ActivityMetrics, PrismaClientOrTx } from "../types";

/**
 * Analytics Stage 1 (docs/analytics-architecture.md §5.2). Three
 * independent `count`s against the Activity table's own `createdAt`
 * column (see calculations/date-ranges.ts's `getCalendarBoundaries` for
 * why these are calendar-aligned, not rolling windows) — no join, no
 * `groupBy`, all three run concurrently.
 */
export async function getActivityMetrics(
  client: PrismaClientOrTx,
  organizationId: string,
  now: Date,
): Promise<ActivityMetrics> {
  const { today, thisWeek, thisMonth } = getCalendarBoundaries(now);

  const [createdToday, createdThisWeek, createdThisMonth] = await Promise.all([
    client.activity.count({ where: { organizationId, createdAt: { gte: today } } }),
    client.activity.count({ where: { organizationId, createdAt: { gte: thisWeek } } }),
    client.activity.count({ where: { organizationId, createdAt: { gte: thisMonth } } }),
  ]);

  return { createdToday, createdThisWeek, createdThisMonth };
}
