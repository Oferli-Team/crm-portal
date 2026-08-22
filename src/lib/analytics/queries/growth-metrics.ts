import { calculateGrowthRate } from "../calculations/rates";
import type { GrowthMetric, PrismaClientOrTx, TimeRangeBounds } from "../types";

function windowFilter(organizationId: string, bounds: TimeRangeBounds) {
  return {
    organizationId,
    createdAt: { ...(bounds.start ? { gte: bounds.start } : {}), lt: bounds.end },
  };
}

function toGrowthMetric(currentPeriodCount: number, previousPeriodCount: number): GrowthMetric {
  return {
    currentPeriodCount,
    previousPeriodCount,
    changePercent: calculateGrowthRate(currentPeriodCount, previousPeriodCount),
  };
}

/**
 * Analytics Stage 1 (docs/analytics-architecture.md §5.4). Two indexed
 * `count`s (current period, previous equal-length period) per dimension —
 * six counts total across all three dimensions, all run concurrently, all
 * filtered on each model's own `createdAt`. `bounds`/`previousBounds` are
 * pre-resolved by the caller (see calculations/date-ranges.ts) — this
 * function only ever runs the six reads and applies the pure rate
 * calculation (calculations/rates.ts's `calculateGrowthRate`).
 */
export async function getGrowthMetrics(
  client: PrismaClientOrTx,
  organizationId: string,
  bounds: TimeRangeBounds,
  previousBounds: TimeRangeBounds,
): Promise<{ clientGrowth: GrowthMetric; projectGrowth: GrowthMetric; taskGrowth: GrowthMetric }> {
  const [clientCurrent, clientPrevious, projectCurrent, projectPrevious, taskCurrent, taskPrevious] = await Promise.all([
    client.client.count({ where: windowFilter(organizationId, bounds) }),
    client.client.count({ where: windowFilter(organizationId, previousBounds) }),
    client.project.count({ where: windowFilter(organizationId, bounds) }),
    client.project.count({ where: windowFilter(organizationId, previousBounds) }),
    client.task.count({ where: windowFilter(organizationId, bounds) }),
    client.task.count({ where: windowFilter(organizationId, previousBounds) }),
  ]);

  return {
    clientGrowth: toGrowthMetric(clientCurrent, clientPrevious),
    projectGrowth: toGrowthMetric(projectCurrent, projectPrevious),
    taskGrowth: toGrowthMetric(taskCurrent, taskPrevious),
  };
}
