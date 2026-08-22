import { prisma } from "@/lib/prisma";
import type { ProjectStatus, InvoiceStatus } from "@/generated/prisma/enums";
import { classifyInvoiceArchival } from "@/lib/invoices/pdf/classify-archival";

// Same definition the staff Dashboard KPI already uses for "active
// projects" (src/app/(dashboard)/dashboard/query.ts) — kept identical so
// the word means the same thing in both places.
const ACTIVE_PROJECT_STATUS: ProjectStatus = "IN_PROGRESS";

// Invoice System Official Slice 5 (docs/invoicing-architecture.md §10) —
// the one authoritative Portal-visible status set. DRAFT is never
// visible to a portal identity on any surface: not the list ("all" or
// "open"), not the detail page, not the overview's recent-invoices or
// open-aggregate. A DRAFT invoice belongs to the still-in-progress
// pre-Issue workflow, which is never shown to a client.
const VISIBLE_PORTAL_STATUSES: readonly InvoiceStatus[] = ["SENT", "OVERDUE", "PAID", "CANCELLED"];

// PAID and CANCELLED are deliberately excluded from "open" — an invoice
// the client no longer owes money on, or one that was called off, isn't
// outstanding work. DRAFT is excluded too — see VISIBLE_PORTAL_STATUSES
// above; "open" is always a subset of "visible," never a separate escape
// hatch that could re-admit DRAFT.
const OPEN_INVOICE_STATUSES: readonly InvoiceStatus[] = ["SENT", "OVERDUE"];

export const PORTAL_INVOICE_FILTERS = ["all", "open", "paid"] as const;
export type PortalInvoiceFilter = (typeof PORTAL_INVOICE_FILTERS)[number];

/** Invalid/missing filter values always fall back to "all", never an error. */
export function parsePortalInvoiceFilter(raw: string | undefined): PortalInvoiceFilter {
  return (PORTAL_INVOICE_FILTERS as readonly string[]).includes(raw ?? "")
    ? (raw as PortalInvoiceFilter)
    : "all";
}

export type PortalProjectSummary = {
  id: string;
  name: string;
  status: ProjectStatus;
  startDate: Date | null;
  endDate: Date | null;
};

export type PortalProjectDetail = PortalProjectSummary & {
  /** Project.description — a client-facing work summary (see seed.ts's own
   * usage, e.g. "Full redesign of the marketing site and blog."), never
   * Project.budget or any staff-internal field. */
  description: string | null;
  clientName: string;
  /**
   * Project.organizationId — kept on this internal, already-scoped detail
   * model purely so the caller can pass it straight into the attachment
   * query (see client-portal/attachments.ts) without a second Prisma round
   * trip. Never render this field in any portal page's JSX.
   */
  organizationId: string | null;
};

export type PortalInvoiceSummary = {
  id: string;
  invoiceNumber: string;
  projectName: string;
  issueDate: Date;
  dueDate: Date | null;
  amount: number;
  currency: string;
  status: InvoiceStatus;
};

export type PortalInvoiceDetail = PortalInvoiceSummary & {
  paidAt: Date | null;
  clientName: string;
  /**
   * Invoice.project.organizationId (deliberately the project's, not the
   * invoice's own organizationId — see client-portal/attachments.ts) kept
   * on this internal, already-scoped detail model so the caller can pass
   * it straight into the attachment query. Never render this field in any
   * portal page's JSX.
   */
  projectOrganizationId: string | null;
  /**
   * Invoice System Official Slice 3, Portal Invoice PDF access —
   * classifyInvoiceArchival()'s own "archived" outcome, computed here from
   * fields never exposed on this type. The page renders a Download PDF
   * link only when this is true; pdfStoragePath/documentVersion/
   * issuerSnapshot/recipientSnapshot/any ledger data are never added to
   * this type and never cross into any portal page's JSX.
   */
  hasArchivedPdf: boolean;
};

export type PortalOverview = {
  activeProjectsCount: number;
  openInvoicesCount: number;
  outstandingAmount: number;
  recentProjects: PortalProjectSummary[];
  recentInvoices: PortalInvoiceSummary[];
};

const PROJECT_SUMMARY_SELECT = {
  id: true,
  name: true,
  status: true,
  startDate: true,
  endDate: true,
} as const;

const INVOICE_SUMMARY_SELECT = {
  id: true,
  invoiceNumber: true,
  issueDate: true,
  dueDate: true,
  amount: true,
  currency: true,
  status: true,
  project: { select: { name: true } },
} as const;

function toInvoiceSummary(invoice: {
  id: string;
  invoiceNumber: string;
  issueDate: Date;
  dueDate: Date | null;
  amount: unknown;
  currency: string;
  status: InvoiceStatus;
  project: { name: string };
}): PortalInvoiceSummary {
  return {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    projectName: invoice.project.name,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    amount: Number(invoice.amount),
    currency: invoice.currency,
    status: invoice.status,
  };
}

/**
 * All Client Portal reads are scoped by clientId alone — the caller must
 * always pass the clientId that getCurrentPortalUser()/getOptionalPortalUser()
 * resolved for the current identity, never a value from a query string,
 * form field, or cookie. No caching layer sits in front of any of these.
 * Invoice reads additionally require organizationId (also from the
 * verified portal identity) as defense in depth beyond clientId.
 */
export async function getPortalOverview(
  clientId: string,
  organizationId: string,
): Promise<PortalOverview> {
  const [activeProjectsCount, openInvoicesAgg, recentProjects, recentInvoices] =
    await Promise.all([
      prisma.project.count({ where: { clientId, status: ACTIVE_PROJECT_STATUS } }),
      prisma.invoice.aggregate({
        where: { clientId, organizationId, status: { in: [...OPEN_INVOICE_STATUSES] } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prisma.project.findMany({
        where: { clientId },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: PROJECT_SUMMARY_SELECT,
      }),
      prisma.invoice.findMany({
        where: { clientId, organizationId, status: { in: [...VISIBLE_PORTAL_STATUSES] } },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: INVOICE_SUMMARY_SELECT,
      }),
    ]);

  return {
    activeProjectsCount,
    openInvoicesCount: openInvoicesAgg._count._all,
    outstandingAmount: Number(openInvoicesAgg._sum.amount ?? 0),
    recentProjects,
    recentInvoices: recentInvoices.map(toInvoiceSummary),
  };
}

export async function getPortalProjects(clientId: string): Promise<PortalProjectSummary[]> {
  return prisma.project.findMany({
    where: { clientId },
    orderBy: { updatedAt: "desc" },
    select: PROJECT_SUMMARY_SELECT,
  });
}

/**
 * Scoped by id + clientId together — a foreign Client's (or foreign
 * organization's) project id simply doesn't match, indistinguishable from
 * a nonexistent one. Callers must notFound() on null, never fall back to
 * a bare id lookup.
 */
export async function getPortalProject(
  clientId: string,
  projectId: string,
): Promise<PortalProjectDetail | null> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, clientId },
    select: {
      ...PROJECT_SUMMARY_SELECT,
      description: true,
      organizationId: true,
      client: { select: { name: true } },
    },
  });

  if (!project) return null;

  return {
    id: project.id,
    name: project.name,
    status: project.status,
    startDate: project.startDate,
    endDate: project.endDate,
    description: project.description,
    clientName: project.client.name,
    organizationId: project.organizationId,
  };
}

export async function getPortalInvoices(
  clientId: string,
  organizationId: string,
  filter: PortalInvoiceFilter,
): Promise<PortalInvoiceSummary[]> {
  // "all" is never unfiltered — it means "every Portal-visible status,"
  // not "every status in the database." DRAFT is excluded from every
  // branch here, not only "open" (Invoice System Official Slice 5,
  // docs/invoicing-architecture.md §10).
  const statusWhere =
    filter === "open"
      ? { in: [...OPEN_INVOICE_STATUSES] }
      : filter === "paid"
        ? ("PAID" as const)
        : { in: [...VISIBLE_PORTAL_STATUSES] };

  const invoices = await prisma.invoice.findMany({
    where: {
      clientId,
      // Defense in depth beyond Invoice.clientId (the primary boundary):
      // also require organizationId (from the verified portal identity)
      // and the invoice's own project to belong to this same Client, in
      // case any of these ever disagree.
      organizationId,
      status: statusWhere,
      project: { clientId },
    },
    orderBy: { createdAt: "desc" },
    select: INVOICE_SUMMARY_SELECT,
  });

  return invoices.map(toInvoiceSummary);
}

/**
 * Scoped by id + clientId + organizationId + project.clientId together —
 * same reasoning as getPortalProject, extended with organizationId as
 * defense in depth. Callers must notFound() on null.
 */
export async function getPortalInvoice(
  clientId: string,
  organizationId: string,
  invoiceId: string,
): Promise<PortalInvoiceDetail | null> {
  const invoice = await prisma.invoice.findFirst({
    where: {
      id: invoiceId,
      clientId,
      organizationId,
      project: { clientId },
      // Invoice System Official Slice 5 (docs/invoicing-architecture.md
      // §10) — a DRAFT invoice must never resolve here, exactly like a
      // nonexistent/cross-tenant id: this returns null, and the caller's
      // existing notFound() produces the identical generic 404.
      status: { in: [...VISIBLE_PORTAL_STATUSES] },
    },
    select: {
      ...INVOICE_SUMMARY_SELECT,
      paidAt: true,
      client: { select: { name: true } },
      project: { select: { name: true, organizationId: true } },
      finalizedAt: true,
      pdfStoragePath: true,
      pdfGeneratedAt: true,
      issuerSnapshot: true,
      recipientSnapshot: true,
      documentVersion: true,
    },
  });

  if (!invoice) return null;

  return {
    ...toInvoiceSummary(invoice),
    paidAt: invoice.paidAt,
    clientName: invoice.client.name,
    projectOrganizationId: invoice.project.organizationId,
    hasArchivedPdf: classifyInvoiceArchival(invoice).kind === "archived",
  };
}
