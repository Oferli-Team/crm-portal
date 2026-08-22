import Link from "next/link";
import { getCurrentUserOrganization } from "@/lib/current-user";
import { prisma } from "@/lib/prisma";
import { ProjectForm } from "@/components/projects/project-form";
import { EmptyState } from "@/components/ui/empty-state";
import { createProjectAction } from "./actions";

export default async function NewProjectPage() {
  const { organizationId } = await getCurrentUserOrganization();
  const clients = await prisma.client.findMany({
    where: { organizationId },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
          Add project
        </h1>
        <Link
          href="/projects"
          className="rounded text-sm text-gray-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
        >
          Cancel
        </Link>
      </div>

      {clients.length === 0 ? (
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
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <ProjectForm action={createProjectAction} clients={clients} />
        </div>
      )}
    </div>
  );
}
