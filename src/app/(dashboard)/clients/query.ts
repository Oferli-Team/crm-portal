import { Prisma } from "@/generated/prisma/client";
import {
  parseSearchParam,
  parsePageParam,
  parseEnumParam,
  parseSortParam,
  type RawSearchParams,
} from "@/lib/list-params";
import { CLIENT_STATUSES } from "@/lib/validation/client";

export const CLIENT_SORT_FIELDS = ["name", "createdAt"] as const;
export type ClientSortField = (typeof CLIENT_SORT_FIELDS)[number];

export type ClientListParams = {
  q: string;
  status?: (typeof CLIENT_STATUSES)[number];
  sortField: ClientSortField;
  sortDir: "asc" | "desc";
  sortCombined: string;
  page: number;
};

export function parseClientListParams(
  searchParams: RawSearchParams,
): ClientListParams {
  const q = parseSearchParam(searchParams.q);
  const status = parseEnumParam(searchParams.status, CLIENT_STATUSES);
  const { field, dir, combined } = parseSortParam(
    searchParams.sort,
    CLIENT_SORT_FIELDS,
    "createdAt:desc",
  );
  const page = parsePageParam(searchParams.page);

  return { q, status, sortField: field, sortDir: dir, sortCombined: combined, page };
}

export function buildClientWhere(
  organizationId: string,
  { q, status }: Pick<ClientListParams, "q" | "status">,
): Prisma.ClientWhereInput {
  return {
    organizationId,
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { company: { contains: q, mode: "insensitive" as const } },
            { email: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
}

export function buildClientOrderBy(
  params: Pick<ClientListParams, "sortField" | "sortDir">,
): Prisma.ClientOrderByWithRelationInput {
  return { [params.sortField]: params.sortDir };
}
