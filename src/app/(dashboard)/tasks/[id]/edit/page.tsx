import { notFound } from "next/navigation";
import Link from "next/link";
import { getCurrentMembership } from "@/lib/current-user";
import { prisma } from "@/lib/prisma";
import { TaskForm } from "@/components/tasks/task-form";
import { updateTaskAction } from "./actions";
import { CommentsSection } from "@/components/comments/comments-section";
import { createTaskCommentAction, editTaskCommentAction, deleteTaskCommentAction } from "./comment-actions";
import { parseSearchParam, type RawSearchParams } from "@/lib/list-params";

function toDateInputValue(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : "";
}

export default async function EditTaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const { id } = await params;
  const resolvedSearchParams = await searchParams;
  const { user, organizationId, membership } = await getCurrentMembership();

  const [task, projects] = await Promise.all([
    prisma.task.findFirst({
      where: { id, project: { organizationId } },
    }),
    prisma.project.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, client: { select: { name: true } } },
    }),
  ]);

  if (!task) {
    notFound();
  }

  const boundUpdateTaskAction = updateTaskAction.bind(null, task.id);
  const commentsCursor = parseSearchParam(resolvedSearchParams.commentsCursor) || undefined;
  const isModerator = membership.role === "OWNER" || membership.role === "ADMIN";

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
          Edit task
        </h1>
        <Link
          href="/tasks"
          className="rounded text-sm text-gray-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
        >
          Cancel
        </Link>
      </div>
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <TaskForm
          action={boundUpdateTaskAction}
          projects={projects.map((project) => ({
            id: project.id,
            label: `${project.name} — ${project.client.name}`,
          }))}
          defaultValues={{
            title: task.title,
            description: task.description ?? "",
            projectId: task.projectId,
            status: task.status,
            priority: task.priority,
            dueDate: toDateInputValue(task.dueDate),
          }}
          submitLabel="Save changes"
          pendingLabel="Saving…"
        />
        <CommentsSection
          entityType="TASK"
          entityId={task.id}
          organizationId={organizationId}
          currentUserId={user.id}
          isModerator={isModerator}
          parentLabel="task"
          basePath={`/tasks/${task.id}/edit`}
          cursorParam="commentsCursor"
          cursor={commentsCursor}
          createAction={createTaskCommentAction.bind(null, task.id)}
          makeEditAction={(commentId) => editTaskCommentAction.bind(null, task.id, commentId)}
          makeDeleteAction={(commentId) => deleteTaskCommentAction.bind(null, task.id, commentId)}
        />
      </div>
    </div>
  );
}
