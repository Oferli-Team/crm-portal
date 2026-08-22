import Link from "next/link";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { prisma } from "@/lib/prisma";
import { formatCurrency } from "@/lib/format";
import { formatInvoiceStatusLabel } from "@/lib/invoices/status-label";
import { formatDateOnlyForDisplay } from "@/lib/invoices/date-only";
import { PAGE_SIZE, getOffset, getTotalPages, type RawSearchParams } from "@/lib/list-params";
import { DeleteButton } from "@/components/ui/delete-button";
import { deleteInvoiceAction } from "./actions";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PencilIcon } from "@/components/ui/icons";
import { SearchFilterBar } from "@/components/list/search-filter-bar";
import { Pagination } from "@/components/list/pagination";
import {
  Table,
  TableHead,
  TableHeaderCell,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { INVOICE_STATUSES } from "@/lib/validation/invoice";
import {
  parseInvoiceListParams,
  buildInvoiceWhere,
  buildInvoiceOrderBy,
} from "./query";

const SORT_OPTIONS = [
  { value: "createdAt:desc", label: "Newest first" },
  { value: "createdAt:asc", label: "Oldest first" },
  { value: "dueDate:asc", label: "Due date (soonest)" },
  { value: "dueDate:desc", label: "Due date (latest)" },
  { value: "amount:desc", label: "Amount (high to low)" },
  { value: "amount:asc", label: "Amount (low to high)" },
];

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const { organizationId } = await getCurrentUserOrganization();
  const resolvedSearchParams = await searchParams;
  const listParams = parseInvoiceListParams(resolvedSearchParams);

  const where = buildInvoiceWhere(organizationId, listParams);
  const orderBy = buildInvoiceOrderBy(listParams);

  const [projectCount, [invoices, total]] = await Promise.all([
    prisma.project.count({ where: { organizationId } }),
    prisma.$transaction([
      prisma.invoice.findMany({
        where,
        orderBy,
        skip: getOffset(listParams.page),
        take: PAGE_SIZE,
        include: {
          project: { select: { name: true, client: { select: { name: true } } } },
        },
      }),
      prisma.invoice.count({ where }),
    ]),
  ]);

  const totalPages = getTotalPages(total);
  const hasActiveParams = Boolean(listParams.q || listParams.status);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
            Invoices
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            {total} {total === 1 ? "invoice" : "invoices"}
          </p>
        </div>
        {projectCount > 0 && (
          <Link
            href="/invoices/new"
            className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
          >
            Add invoice
          </Link>
        )}
      </div>

      {projectCount > 0 && (
        <SearchFilterBar
          basePath="/invoices"
          searchValue={listParams.q}
          searchPlaceholder="Search by invoice #, project, or client"
          filters={[
            {
              name: "status",
              label: "Status",
              value: listParams.status ?? "",
              options: [
                { value: "", label: "All statuses" },
                ...INVOICE_STATUSES.map((status) => ({
                  value: status,
                  label: formatInvoiceStatusLabel(status),
                })),
              ],
            },
          ]}
          sort={{ value: listParams.sortCombined, options: SORT_OPTIONS }}
          hasActiveParams={hasActiveParams}
        />
      )}

      {total === 0 ? (
        projectCount === 0 ? (
          <EmptyState
            title="You need a project first"
            description="Invoices must belong to a project. Add one before creating an invoice."
            action={
              <Link
                href="/projects/new"
                className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
              >
                Add project
              </Link>
            }
          />
        ) : hasActiveParams ? (
          <EmptyState
            title="No matching invoices"
            description="Try a different search term or clear your filters."
            action={
              <Link
                href="/invoices"
                className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
              >
                Clear filters
              </Link>
            }
          />
        ) : (
          <EmptyState
            title="No invoices yet"
            description="Get started by adding your first invoice."
            action={
              <Link
                href="/invoices/new"
                className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
              >
                Add invoice
              </Link>
            }
          />
        )
      ) : (
        <>
          <Table>
            <TableHead>
              <tr>
                <TableHeaderCell>Invoice #</TableHeaderCell>
                <TableHeaderCell>Project</TableHeaderCell>
                <TableHeaderCell>Client</TableHeaderCell>
                <TableHeaderCell>Amount</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Due date</TableHeaderCell>
                <TableHeaderCell>Created</TableHeaderCell>
                <TableHeaderCell align="right">Actions</TableHeaderCell>
              </tr>
            </TableHead>
            <TableBody>
              {invoices.map((invoice) => (
                <TableRow key={invoice.id}>
                  <TableCell emphasis>{invoice.invoiceNumber}</TableCell>
                  <TableCell>{invoice.project.name}</TableCell>
                  <TableCell>{invoice.project.client.name}</TableCell>
                  <TableCell>
                    {formatCurrency(Number(invoice.amount), invoice.currency)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={invoice.status} label={formatInvoiceStatusLabel(invoice.status)} />
                  </TableCell>
                  <TableCell>
                    {invoice.dueDate
                      ? formatDateOnlyForDisplay(invoice.dueDate)
                      : "—"}
                  </TableCell>
                  <TableCell>{invoice.createdAt.toLocaleDateString()}</TableCell>
                  <TableCell align="right">
                    <div className="flex items-center justify-end gap-4">
                      {invoice.status === "DRAFT" ? (
                        <>
                          <Link
                            href={`/invoices/${invoice.id}/edit`}
                            className="inline-flex items-center gap-1 rounded text-sm font-medium text-gray-700 transition-colors hover:text-gray-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
                          >
                            <PencilIcon className="h-3.5 w-3.5" />
                            Edit
                          </Link>
                          <DeleteButton
                            action={deleteInvoiceAction.bind(null, invoice.id)}
                            itemName={invoice.invoiceNumber}
                            confirmTitle="Delete invoice"
                            confirmDescription={`Delete invoice ${invoice.invoiceNumber}? This action cannot be undone.`}
                            successMessage="Invoice deleted"
                            conflictMessage="This invoice can no longer be deleted — it may have already been issued."
                          />
                        </>
                      ) : (
                        <Link
                          href={`/invoices/${invoice.id}/edit`}
                          className="inline-flex items-center gap-1 rounded text-sm font-medium text-gray-700 transition-colors hover:text-gray-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
                        >
                          View
                        </Link>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination
            basePath="/invoices"
            params={{
              ...(listParams.q ? { q: listParams.q } : {}),
              ...(listParams.status ? { status: listParams.status } : {}),
              sort: listParams.sortCombined,
            }}
            page={listParams.page}
            totalPages={totalPages}
          />
        </>
      )}
    </div>
  );
}
