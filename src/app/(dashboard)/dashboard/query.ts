import { prisma } from "@/lib/prisma";
import { formatActivity, type ActivityDisplayModel } from "@/lib/activity/format-activity";
import { InvoiceStatus, TaskStatus, ProjectStatus } from "@/generated/prisma/enums";
import type { DashboardPeriod } from "@/lib/dashboard/period";
import { getDashboardPeriodRange, type DashboardBucketUnit } from "@/lib/dashboard/period";
import { bucketRevenue, type RevenueResult } from "@/lib/dashboard/revenue";

// PAID and CANCELLED are excluded; everything else (DRAFT, SENT, OVERDUE)
// still represents money the client owes. Kept here as its own copy — this
// module is the new authoritative home for dashboard query logic, but
// dashboard/page.tsx (untouched this stage) still has its own identical
// definition for its own, still-separate query.
const UNPAID_INVOICE_STATUSES = ["DRAFT", "SENT", "OVERDUE"] as const;

const RECENT_ACTIVITY_TAKE = 8;
const LIST_TAKE = 5;
const OVERDUE_ITEMS_TAKE = 8;

export type StatusBreakdownItem<S extends string> = { status: S; count: number };

/** Every known status is present, including ones with zero rows. */
function normalizeStatusBreakdown<S extends string>(
  allStatuses: readonly S[],
  grouped: { status: S; _count: number }[],
): StatusBreakdownItem<S>[] {
  const counts = new Map(grouped.map((g) => [g.status, g._count]));
  return allStatuses.map((status) => ({ status, count: counts.get(status) ?? 0 }));
}

export type UpcomingOrOverdueTask = {
  id: string;
  title: string;
  dueDate: Date;
  projectName: string;
};

export type RecentInvoice = {
  id: string;
  invoiceNumber: string;
  status: string;
  amount: number;
  currency: string;
  clientName: string;
  createdAt: Date;
};

/**
 * A discriminated union rather than one flattened shape — Task and Invoice
 * are genuinely different things sharing only "has a due date that's
 * passed", and the UI needs to tell them apart, not paper over it.
 */
export type OverdueItem =
  | { kind: "task"; id: string; title: string; dueDate: Date; projectName: string }
  | {
      kind: "invoice";
      id: string;
      invoiceNumber: string;
      dueDate: Date;
      clientName: string;
      amount: number;
      currency: string;
    };

export type DashboardAnalytics = {
  period: DashboardPeriod;
  periodRange: { start: Date; end: Date; bucketUnit: DashboardBucketUnit };
  kpis: {
    totalClients: number;
    activeProjects: number;
    openTasks: number;
    overdueTasksCount: number;
    outstandingAmount: number;
    paidRevenue: number;
  };
  revenue: RevenueResult;
  breakdowns: {
    invoiceStatus: StatusBreakdownItem<string>[];
    taskStatus: StatusBreakdownItem<string>[];
    projectStatus: StatusBreakdownItem<string>[];
  };
  recentActivity: { id: string; display: ActivityDisplayModel }[];
  upcomingTasks: UpcomingOrOverdueTask[];
  overdueTasks: UpcomingOrOverdueTask[];
  /** overdueTasks + overdue Invoices, merged and sorted by dueDate ascending, capped at 8. */
  overdueItems: OverdueItem[];
  recentInvoices: RecentInvoice[];
};

/**
 * Single entry point for all Dashboard Analytics data. `organizationId` must
 * already be resolved by the caller from the current session/cookie (via
 * getCurrentUserOrganization) — this function never reads it from
 * searchParams or any other client-controlled input, and never resolves it
 * itself. `now` is likewise always caller-supplied (never `new Date()`
 * inside here), so every query in this call — and the bucketing derived
 * from them — is evaluated against exactly one consistent instant.
 *
 * Every Prisma call below is independent of every other, so they all run
 * concurrently in one Promise.all — no query here depends on another's
 * result, and no list query triggers per-row follow-up queries (all
 * relation data is pulled via select/include up front). Nothing here is
 * cached: the active organization lives in a cookie and can change from one
 * request to the next, so a shared cache keyed on anything less specific
 * than (organizationId, period, now) would risk leaking one organization's
 * numbers into another's view.
 */
export async function getDashboardAnalytics({
  organizationId,
  period,
  now,
}: {
  organizationId: string;
  period: DashboardPeriod;
  now: Date;
}): Promise<DashboardAnalytics> {
  const periodRange = getDashboardPeriodRange(period, now);

  const [
    totalClients,
    activeProjects,
    openTasks,
    overdueTasksCount,
    outstandingAgg,
    paidInvoicesInPeriod,
    invoiceStatusGrouped,
    taskStatusGrouped,
    projectStatusGrouped,
    activityRows,
    upcomingTasksRows,
    overdueTasksRows,
    overdueInvoicesRows,
    recentInvoicesRows,
  ] = await Promise.all([
    prisma.client.count({ where: { organizationId } }),
    prisma.project.count({ where: { organizationId, status: "IN_PROGRESS" } }),
    prisma.task.count({ where: { project: { organizationId }, status: { not: "DONE" } } }),
    prisma.task.count({
      where: { project: { organizationId }, status: { not: "DONE" }, dueDate: { lt: now } },
    }),
    prisma.invoice.aggregate({
      where: { organizationId, project: { organizationId }, status: { in: [...UNPAID_INVOICE_STATUSES] } },
      _sum: { amount: true },
    }),
    // Selected once, used for both the paidRevenue KPI (sum) and the
    // revenue time series (bucketing) below — never queried twice.
    prisma.invoice.findMany({
      where: {
        organizationId,
        project: { organizationId },
        status: "PAID",
        paidAt: { not: null, gte: periodRange.start, lte: periodRange.end },
      },
      select: { amount: true, paidAt: true },
    }),
    prisma.invoice.groupBy({
      by: ["status"],
      where: { organizationId, project: { organizationId } },
      _count: true,
    }),
    prisma.task.groupBy({
      by: ["status"],
      where: { project: { organizationId } },
      _count: true,
    }),
    prisma.project.groupBy({
      by: ["status"],
      where: { organizationId },
      _count: true,
    }),
    prisma.activity.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: RECENT_ACTIVITY_TAKE,
      include: { actor: { select: { name: true, email: true } } },
    }),
    prisma.task.findMany({
      where: { project: { organizationId }, status: { not: "DONE" }, dueDate: { not: null, gte: now } },
      orderBy: { dueDate: "asc" },
      take: LIST_TAKE,
      include: { project: { select: { name: true } } },
    }),
    prisma.task.findMany({
      where: { project: { organizationId }, status: { not: "DONE" }, dueDate: { lt: now } },
      orderBy: { dueDate: "asc" },
      take: LIST_TAKE,
      include: { project: { select: { name: true } } },
    }),
    // Real OVERDUE status, not a re-derived "dueDate < now" check — an
    // invoice only counts here once someone has actually marked it OVERDUE.
    // dueDate is nullable in the schema; excluded here since a due-date-
    // sorted list has nothing meaningful to do with a null one.
    prisma.invoice.findMany({
      where: { organizationId, project: { organizationId }, status: "OVERDUE", dueDate: { not: null } },
      orderBy: { dueDate: "asc" },
      take: LIST_TAKE,
      include: { project: { select: { client: { select: { name: true } } } } },
    }),
    prisma.invoice.findMany({
      where: { organizationId, project: { organizationId } },
      orderBy: { createdAt: "desc" },
      take: LIST_TAKE,
      include: { project: { select: { client: { select: { name: true } } } } },
    }),
  ]);

  // paidInvoicesInPeriod rows are already scoped to `paidAt not null AND in
  // range` by the query above, so bucketRevenue's total and buckets both
  // come from this one fetch.
  const revenue = bucketRevenue(
    paidInvoicesInPeriod.map((row) => ({ amount: row.amount, paidAt: row.paidAt as Date })),
    periodRange,
  );

  const overdueItems: OverdueItem[] = [
    ...overdueTasksRows.map(
      (task): OverdueItem => ({
        kind: "task",
        id: task.id,
        title: task.title,
        dueDate: task.dueDate as Date,
        projectName: task.project.name,
      }),
    ),
    ...overdueInvoicesRows.map(
      (invoice): OverdueItem => ({
        kind: "invoice",
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        dueDate: invoice.dueDate as Date,
        clientName: invoice.project.client.name,
        amount: Number(invoice.amount),
        currency: invoice.currency,
      }),
    ),
  ]
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
    .slice(0, OVERDUE_ITEMS_TAKE);

  return {
    period,
    periodRange: { start: periodRange.start, end: periodRange.end, bucketUnit: periodRange.bucketUnit },
    kpis: {
      totalClients,
      activeProjects,
      openTasks,
      overdueTasksCount,
      outstandingAmount: Number(outstandingAgg._sum.amount ?? 0),
      paidRevenue: revenue.total,
    },
    revenue,
    breakdowns: {
      invoiceStatus: normalizeStatusBreakdown(Object.values(InvoiceStatus), invoiceStatusGrouped),
      taskStatus: normalizeStatusBreakdown(Object.values(TaskStatus), taskStatusGrouped),
      projectStatus: normalizeStatusBreakdown(Object.values(ProjectStatus), projectStatusGrouped),
    },
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
    upcomingTasks: upcomingTasksRows.map((task) => ({
      id: task.id,
      title: task.title,
      dueDate: task.dueDate as Date,
      projectName: task.project.name,
    })),
    overdueTasks: overdueTasksRows.map((task) => ({
      id: task.id,
      title: task.title,
      dueDate: task.dueDate as Date,
      projectName: task.project.name,
    })),
    overdueItems,
    recentInvoices: recentInvoicesRows.map((invoice) => ({
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      amount: Number(invoice.amount),
      currency: invoice.currency,
      clientName: invoice.project.client.name,
      createdAt: invoice.createdAt,
    })),
  };
}
