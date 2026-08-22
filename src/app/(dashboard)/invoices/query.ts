import { Prisma } from "@/generated/prisma/client";
import {
  parseSearchParam,
  parsePageParam,
  parseEnumParam,
  parseSortParam,
  type RawSearchParams,
} from "@/lib/list-params";
import { INVOICE_STATUSES } from "@/lib/validation/invoice";

export const INVOICE_SORT_FIELDS = ["dueDate", "createdAt", "amount"] as const;
export type InvoiceSortField = (typeof INVOICE_SORT_FIELDS)[number];

export type InvoiceListParams = {
  q: string;
  status?: (typeof INVOICE_STATUSES)[number];
  sortField: InvoiceSortField;
  sortDir: "asc" | "desc";
  sortCombined: string;
  page: number;
};

export function parseInvoiceListParams(
  searchParams: RawSearchParams,
): InvoiceListParams {
  const q = parseSearchParam(searchParams.q);
  const status = parseEnumParam(searchParams.status, INVOICE_STATUSES);
  const { field, dir, combined } = parseSortParam(
    searchParams.sort,
    INVOICE_SORT_FIELDS,
    "createdAt:desc",
  );
  const page = parsePageParam(searchParams.page);

  return { q, status, sortField: field, sortDir: dir, sortCombined: combined, page };
}

export function buildInvoiceWhere(
  organizationId: string,
  { q, status }: Pick<InvoiceListParams, "q" | "status">,
): Prisma.InvoiceWhereInput {
  return {
    // organizationId (required, kept consistent with project.organizationId
    // by every write path) is the primary predicate; the project relation
    // check is retained as defense in depth against inconsistent data.
    organizationId,
    project: { organizationId },
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { invoiceNumber: { contains: q, mode: "insensitive" as const } },
            { project: { name: { contains: q, mode: "insensitive" as const } } },
            {
              project: {
                client: { name: { contains: q, mode: "insensitive" as const } },
              },
            },
          ],
        }
      : {}),
  };
}

export function buildInvoiceOrderBy(
  params: Pick<InvoiceListParams, "sortField" | "sortDir">,
): Prisma.InvoiceOrderByWithRelationInput {
  return { [params.sortField]: params.sortDir };
}
