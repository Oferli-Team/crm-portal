import { Prisma } from "@/generated/prisma/client";
import {
  parseSearchParam,
  parsePageParam,
  parseEnumParam,
  parseSortParam,
  type RawSearchParams,
} from "@/lib/list-params";
import { PROJECT_STATUSES } from "@/lib/validation/project";

export const PROJECT_SORT_FIELDS = ["name", "createdAt"] as const;
export type ProjectSortField = (typeof PROJECT_SORT_FIELDS)[number];

export type ProjectListParams = {
  q: string;
  status?: (typeof PROJECT_STATUSES)[number];
  sortField: ProjectSortField;
  sortDir: "asc" | "desc";
  sortCombined: string;
  page: number;
};

export function parseProjectListParams(
  searchParams: RawSearchParams,
): ProjectListParams {
  const q = parseSearchParam(searchParams.q);
  const status = parseEnumParam(searchParams.status, PROJECT_STATUSES);
  const { field, dir, combined } = parseSortParam(
    searchParams.sort,
    PROJECT_SORT_FIELDS,
    "createdAt:desc",
  );
  const page = parsePageParam(searchParams.page);

  return { q, status, sortField: field, sortDir: dir, sortCombined: combined, page };
}

export function buildProjectWhere(
  organizationId: string,
  { q, status }: Pick<ProjectListParams, "q" | "status">,
): Prisma.ProjectWhereInput {
  return {
    organizationId,
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { client: { name: { contains: q, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };
}

export function buildProjectOrderBy(
  params: Pick<ProjectListParams, "sortField" | "sortDir">,
): Prisma.ProjectOrderByWithRelationInput {
  return { [params.sortField]: params.sortDir };
}
