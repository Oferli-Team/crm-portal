import type { OrganizationMetrics, PrismaClientOrTx } from "../types";

/**
 * Analytics Stage 1 (docs/analytics-architecture.md §5.1). One bounded,
 * org-scoped read — every count runs concurrently (Promise.all), never
 * N+1, never an unbounded scan (every query is a `count`/`groupBy`
 * aggregate, never a `findMany` of full rows). Mirrors src/lib/billing/
 * usage.ts's own shape.
 *
 * `completedTasks`/`openTasks` are two independent `count` calls rather
 * than one `groupBy` + in-memory split — `openTasks` needs an `in` filter
 * over three statuses (TODO/IN_PROGRESS/IN_REVIEW), and Postgres already
 * evaluates both as index-backed scans against `Task_status_idx`; a
 * `groupBy` here would still need the same client-side reduction to
 * collapse three groups into one "open" bucket, for no query-count saving.
 */
export async function getOrganizationMetrics(
  client: PrismaClientOrTx,
  organizationId: string,
): Promise<OrganizationMetrics> {
  const [totalClients, totalProjects, totalTasks, completedTasks, openTasks, totalInvoices, totalMembers, totalAttachments] =
    await Promise.all([
      client.client.count({ where: { organizationId } }),
      client.project.count({ where: { organizationId } }),
      client.task.count({ where: { organizationId } }),
      client.task.count({ where: { organizationId, status: "DONE" } }),
      client.task.count({ where: { organizationId, status: { in: ["TODO", "IN_PROGRESS", "IN_REVIEW"] } } }),
      client.invoice.count({ where: { organizationId } }),
      client.membership.count({ where: { organizationId } }),
      client.attachment.count({ where: { organizationId } }),
    ]);

  return {
    totalClients,
    totalProjects,
    totalTasks,
    completedTasks,
    openTasks,
    totalInvoices,
    totalMembers,
    totalAttachments,
  };
}
