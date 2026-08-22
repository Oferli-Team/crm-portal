import Link from "next/link";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { prisma } from "@/lib/prisma";
import { formatStatusLabel } from "@/lib/format";
import { PAGE_SIZE, getOffset, getTotalPages, type RawSearchParams } from "@/lib/list-params";
import { DeleteButton } from "@/components/ui/delete-button";
import { deleteTaskAction } from "./actions";
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
import { TASK_STATUSES, TASK_PRIORITIES } from "@/lib/validation/task";
import { parseTaskListParams, buildTaskWhere, buildTaskOrderBy } from "./query";

const SORT_OPTIONS = [
  { value: "createdAt:desc", label: "Newest first" },
  { value: "createdAt:asc", label: "Oldest first" },
  { value: "dueDate:asc", label: "Due date (soonest)" },
  { value: "dueDate:desc", label: "Due date (latest)" },
];

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const { organizationId } = await getCurrentUserOrganization();
  const resolvedSearchParams = await searchParams;
  const listParams = parseTaskListParams(resolvedSearchParams);

  const where = buildTaskWhere(organizationId, listParams);
  const orderBy = buildTaskOrderBy(listParams);

  const [projectCount, [tasks, total]] = await Promise.all([
    prisma.project.count({ where: { organizationId } }),
    prisma.$transaction([
      prisma.task.findMany({
        where,
        orderBy,
        skip: getOffset(listParams.page),
        take: PAGE_SIZE,
        include: {
          project: { select: { name: true, client: { select: { name: true } } } },
        },
      }),
      prisma.task.count({ where }),
    ]),
  ]);

  const totalPages = getTotalPages(total);
  const hasActiveParams = Boolean(
    listParams.q || listParams.status || listParams.priority,
  );

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
            Tasks
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            {total} {total === 1 ? "task" : "tasks"}
          </p>
        </div>
        {projectCount > 0 && (
          <Link
            href="/tasks/new"
            className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
          >
            Add task
          </Link>
        )}
      </div>

      {projectCount > 0 && (
        <SearchFilterBar
          basePath="/tasks"
          searchValue={listParams.q}
          searchPlaceholder="Search by title or project"
          filters={[
            {
              name: "status",
              label: "Status",
              value: listParams.status ?? "",
              options: [
                { value: "", label: "All statuses" },
                ...TASK_STATUSES.map((status) => ({
                  value: status,
                  label: formatStatusLabel(status),
                })),
              ],
            },
            {
              name: "priority",
              label: "Priority",
              value: listParams.priority ?? "",
              options: [
                { value: "", label: "All priorities" },
                ...TASK_PRIORITIES.map((priority) => ({
                  value: priority,
                  label: formatStatusLabel(priority),
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
            description="Tasks must belong to a project. Add one before creating a task."
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
            title="No matching tasks"
            description="Try a different search term or clear your filters."
            action={
              <Link
                href="/tasks"
                className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
              >
                Clear filters
              </Link>
            }
          />
        ) : (
          <EmptyState
            title="No tasks yet"
            description="Tasks break a project down into the specific work you need to track and complete."
            action={
              <Link
                href="/tasks/new"
                className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
              >
                Create your first task
              </Link>
            }
          />
        )
      ) : (
        <>
          <Table>
            <TableHead>
              <tr>
                <TableHeaderCell>Title</TableHeaderCell>
                <TableHeaderCell>Project</TableHeaderCell>
                <TableHeaderCell>Client</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Priority</TableHeaderCell>
                <TableHeaderCell>Due date</TableHeaderCell>
                <TableHeaderCell>Completed</TableHeaderCell>
                <TableHeaderCell>Created</TableHeaderCell>
                <TableHeaderCell align="right">Actions</TableHeaderCell>
              </tr>
            </TableHead>
            <TableBody>
              {tasks.map((task) => (
                <TableRow key={task.id}>
                  <TableCell emphasis>{task.title}</TableCell>
                  <TableCell>{task.project.name}</TableCell>
                  <TableCell>{task.project.client.name}</TableCell>
                  <TableCell>
                    <StatusBadge status={task.status} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={task.priority} />
                  </TableCell>
                  <TableCell>
                    {task.dueDate ? task.dueDate.toLocaleDateString() : "—"}
                  </TableCell>
                  <TableCell>
                    {task.completedAt
                      ? task.completedAt.toLocaleDateString()
                      : "—"}
                  </TableCell>
                  <TableCell>{task.createdAt.toLocaleDateString()}</TableCell>
                  <TableCell align="right">
                    <div className="flex items-center justify-end gap-4">
                      <Link
                        href={`/tasks/${task.id}/edit`}
                        className="inline-flex items-center gap-1 rounded text-sm font-medium text-gray-700 transition-colors hover:text-gray-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
                      >
                        <PencilIcon className="h-3.5 w-3.5" />
                        Edit
                      </Link>
                      <DeleteButton
                        action={deleteTaskAction.bind(null, task.id)}
                        itemName={task.title}
                        confirmTitle="Delete task"
                        confirmDescription={`Delete "${task.title}"? This action cannot be undone.`}
                        successMessage="Task deleted"
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination
            basePath="/tasks"
            params={{
              ...(listParams.q ? { q: listParams.q } : {}),
              ...(listParams.status ? { status: listParams.status } : {}),
              ...(listParams.priority ? { priority: listParams.priority } : {}),
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
