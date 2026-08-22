import { notFound } from "next/navigation";
import Link from "next/link";
import { getCurrentMembership } from "@/lib/current-user";
import { prisma } from "@/lib/prisma";
import { ProjectForm } from "@/components/projects/project-form";
import { updateProjectAction } from "./actions";
import { ProjectAttachmentsSection } from "./attachments-section";
import { CommentsSection } from "@/components/comments/comments-section";
import { createProjectCommentAction, editProjectCommentAction, deleteProjectCommentAction } from "./comment-actions";
import { parseSearchParam, type RawSearchParams } from "@/lib/list-params";

function toDateInputValue(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : "";
}

export default async function EditProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const { id } = await params;
  const resolvedSearchParams = await searchParams;
  const { user, organizationId, membership } = await getCurrentMembership();

  const [project, clients] = await Promise.all([
    prisma.project.findFirst({
      where: { id, organizationId },
    }),
    prisma.client.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  if (!project) {
    notFound();
  }

  const boundUpdateProjectAction = updateProjectAction.bind(null, project.id);
  const commentsCursor = parseSearchParam(resolvedSearchParams.commentsCursor) || undefined;
  const isModerator = membership.role === "OWNER" || membership.role === "ADMIN";

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
          Edit project
        </h1>
        <Link
          href="/projects"
          className="rounded text-sm text-gray-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
        >
          Cancel
        </Link>
      </div>
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <ProjectForm
          action={boundUpdateProjectAction}
          clients={clients}
          defaultValues={{
            name: project.name,
            clientId: project.clientId,
            status: project.status,
            startDate: toDateInputValue(project.startDate),
            endDate: toDateInputValue(project.endDate),
          }}
          submitLabel="Save changes"
          pendingLabel="Saving…"
        />
        <ProjectAttachmentsSection projectId={project.id} organizationId={organizationId} />
        <CommentsSection
          entityType="PROJECT"
          entityId={project.id}
          organizationId={organizationId}
          currentUserId={user.id}
          isModerator={isModerator}
          parentLabel="project"
          basePath={`/projects/${project.id}/edit`}
          cursorParam="commentsCursor"
          cursor={commentsCursor}
          createAction={createProjectCommentAction.bind(null, project.id)}
          makeEditAction={(commentId) => editProjectCommentAction.bind(null, project.id, commentId)}
          makeDeleteAction={(commentId) => deleteProjectCommentAction.bind(null, project.id, commentId)}
        />
      </div>
    </div>
  );
}
