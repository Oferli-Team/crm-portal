import Link from "next/link";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { prisma } from "@/lib/prisma";
import { formatStatusLabel } from "@/lib/format";
import { PAGE_SIZE, getOffset, getTotalPages, type RawSearchParams } from "@/lib/list-params";
import { DeleteButton } from "@/components/ui/delete-button";
import { deleteProjectAction } from "./actions";
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
import { PROJECT_STATUSES } from "@/lib/validation/project";
import {
  parseProjectListParams,
  buildProjectWhere,
  buildProjectOrderBy,
} from "./query";

const SORT_OPTIONS = [
  { value: "createdAt:desc", label: "Newest first" },
  { value: "createdAt:asc", label: "Oldest first" },
  { value: "name:asc", label: "Name (A–Z)" },
  { value: "name:desc", label: "Name (Z–A)" },
];

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const { organizationId } = await getCurrentUserOrganization();
  const resolvedSearchParams = await searchParams;
  const listParams = parseProjectListParams(resolvedSearchParams);

  const where = buildProjectWhere(organizationId, listParams);
  const orderBy = buildProjectOrderBy(listParams);

  const [clientCount, [projects, total]] = await Promise.all([
    prisma.client.count({ where: { organizationId } }),
    prisma.$transaction([
      prisma.project.findMany({
        where,
        orderBy,
        skip: getOffset(listParams.page),
        take: PAGE_SIZE,
        include: { client: { select: { name: true } } },
      }),
      prisma.project.count({ where }),
    ]),
  ]);

  const totalPages = getTotalPages(total);
  const hasActiveParams = Boolean(listParams.q || listParams.status);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
            Projects
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            {total} {total === 1 ? "project" : "projects"}
          </p>
        </div>
        {clientCount > 0 && (
          <Link
            href="/projects/new"
            className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
          >
            Add project
          </Link>
        )}
      </div>

      {clientCount > 0 && (
        <SearchFilterBar
          basePath="/projects"
          searchValue={listParams.q}
          searchPlaceholder="Search by name or client"
          filters={[
            {
              name: "status",
              label: "Status",
              value: listParams.status ?? "",
              options: [
                { value: "", label: "All statuses" },
                ...PROJECT_STATUSES.map((status) => ({
                  value: status,
                  label: formatStatusLabel(status),
                })),
              ],
            },
          ]}
          sort={{ value: listParams.sortCombined, options: SORT_OPTIONS }}
          hasActiveParams={hasActiveParams}
        />
      )}

      {total === 0 ? (
        clientCount === 0 ? (
          <EmptyState
            title="You need a client first"
            description="Projects must belong to a client. Add one before creating a project."
            action={
              <Link
                href="/clients/new"
                className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
              >
                Add client
              </Link>
            }
          />
        ) : hasActiveParams ? (
          <EmptyState
            title="No matching projects"
            description="Try a different search term or clear your filters."
            action={
              <Link
                href="/projects"
                className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
              >
                Clear filters
              </Link>
            }
          />
        ) : (
          <EmptyState
            title="No projects yet"
            description="Projects organize your work for a client — group related tasks together and track progress from start to finish."
            action={
              <Link
                href="/projects/new"
                className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
              >
                Create your first project
              </Link>
            }
          />
        )
      ) : (
        <>
          <Table>
            <TableHead>
              <tr>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Client</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Start date</TableHeaderCell>
                <TableHeaderCell>End date</TableHeaderCell>
                <TableHeaderCell>Created</TableHeaderCell>
                <TableHeaderCell align="right">Actions</TableHeaderCell>
              </tr>
            </TableHead>
            <TableBody>
              {projects.map((project) => (
                <TableRow key={project.id}>
                  <TableCell emphasis>{project.name}</TableCell>
                  <TableCell>{project.client.name}</TableCell>
                  <TableCell>
                    <StatusBadge status={project.status} />
                  </TableCell>
                  <TableCell>
                    {project.startDate
                      ? project.startDate.toLocaleDateString()
                      : "—"}
                  </TableCell>
                  <TableCell>
                    {project.endDate
                      ? project.endDate.toLocaleDateString()
                      : "—"}
                  </TableCell>
                  <TableCell>{project.createdAt.toLocaleDateString()}</TableCell>
                  <TableCell align="right">
                    <div className="flex items-center justify-end gap-4">
                      <Link
                        href={`/projects/${project.id}/edit`}
                        className="inline-flex items-center gap-1 rounded text-sm font-medium text-gray-700 transition-colors hover:text-gray-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
                      >
                        <PencilIcon className="h-3.5 w-3.5" />
                        Edit
                      </Link>
                      <DeleteButton
                        action={deleteProjectAction.bind(null, project.id)}
                        itemName={project.name}
                        confirmTitle="Delete project"
                        confirmDescription={`Delete ${project.name}? This action cannot be undone.`}
                        successMessage="Project deleted"
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination
            basePath="/projects"
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
