import { Prisma } from "@/generated/prisma/client";
import {
  parseSearchParam,
  parsePageParam,
  parseEnumParam,
  parseSortParam,
  type RawSearchParams,
} from "@/lib/list-params";
import { TASK_STATUSES, TASK_PRIORITIES } from "@/lib/validation/task";

export const TASK_SORT_FIELDS = ["dueDate", "createdAt"] as const;
export type TaskSortField = (typeof TASK_SORT_FIELDS)[number];

export type TaskListParams = {
  q: string;
  status?: (typeof TASK_STATUSES)[number];
  priority?: (typeof TASK_PRIORITIES)[number];
  sortField: TaskSortField;
  sortDir: "asc" | "desc";
  sortCombined: string;
  page: number;
};

export function parseTaskListParams(
  searchParams: RawSearchParams,
): TaskListParams {
  const q = parseSearchParam(searchParams.q);
  const status = parseEnumParam(searchParams.status, TASK_STATUSES);
  const priority = parseEnumParam(searchParams.priority, TASK_PRIORITIES);
  const { field, dir, combined } = parseSortParam(
    searchParams.sort,
    TASK_SORT_FIELDS,
    "createdAt:desc",
  );
  const page = parsePageParam(searchParams.page);

  return {
    q,
    status,
    priority,
    sortField: field,
    sortDir: dir,
    sortCombined: combined,
    page,
  };
}

export function buildTaskWhere(
  organizationId: string,
  { q, status, priority }: Pick<TaskListParams, "q" | "status" | "priority">,
): Prisma.TaskWhereInput {
  return {
    project: { organizationId },
    ...(status ? { status } : {}),
    ...(priority ? { priority } : {}),
    ...(q
      ? {
          OR: [
            { title: { contains: q, mode: "insensitive" as const } },
            { project: { name: { contains: q, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };
}

export function buildTaskOrderBy(
  params: Pick<TaskListParams, "sortField" | "sortDir">,
): Prisma.TaskOrderByWithRelationInput {
  return { [params.sortField]: params.sortDir };
}
