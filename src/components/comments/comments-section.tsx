import { EmptyState } from "@/components/ui/empty-state";
import { LoadMoreLink } from "@/components/activity/load-more-link";
import { CommentComposer } from "./comment-composer";
import { CommentList } from "./comment-list";
import { getCommentsPage, COMMENT_PAGE_SIZE } from "@/lib/comments/queries";
import { getMentionCandidates } from "@/lib/comments/mention-candidates";
import { formatCommentViewModel } from "@/lib/comments/format-comment";
import type { CommentEntityType } from "@/generated/prisma/enums";
import type { CommentActionState } from "@/types";

/**
 * Comments & Mentions Stage 4 (docs/comments-architecture.md §6) —
 * entity-agnostic Comments UI, mirroring AttachmentsSection's own
 * `entityType`/`entityId`/`organizationId` parameterization exactly (§6:
 * "mirroring AttachmentsSection"). Rendered as its own section on both the
 * Project and Task edit pages.
 *
 * Server Component, server-rendered on first paint (getCommentsPage +
 * getMentionCandidates both run here, in parallel) — no client-side fetch
 * after hydration, no polling, no realtime, consistent with every other
 * read-model in this app. "Load earlier comments" is a real link carrying
 * the next keyset cursor forward (same non-accumulating window-at-a-time
 * behavior the existing Notifications inbox's own "Load more" already
 * has) — not client-side infinite scroll.
 *
 * Comments are fetched newest-first (getCommentsPage's own keyset order,
 * identical to Activity/Notifications) and reversed here for oldest-first
 * display — the one place this feature deliberately reads the opposite
 * direction from every other feed in this app (§6).
 */
export async function CommentsSection({
  entityType,
  entityId,
  organizationId,
  currentUserId,
  isModerator,
  parentLabel,
  basePath,
  cursorParam,
  cursor,
  createAction,
  makeEditAction,
  makeDeleteAction,
}: {
  entityType: CommentEntityType;
  entityId: string;
  organizationId: string;
  currentUserId: string;
  isModerator: boolean;
  parentLabel: string;
  /** The page's own path, e.g. `/projects/${id}/edit` — used to build the "Load earlier" link without disturbing any other searchParams already on this page. */
  basePath: string;
  /** e.g. "commentsCursor" — kept distinct from any other paginated list this page might have. */
  cursorParam: string;
  cursor?: string | null;
  createAction: (prevState: CommentActionState, formData: FormData) => Promise<CommentActionState>;
  makeEditAction: (commentId: string) => (prevState: CommentActionState, formData: FormData) => Promise<CommentActionState>;
  makeDeleteAction: (commentId: string) => () => Promise<void>;
}) {
  const [page, candidates] = await Promise.all([
    getCommentsPage({ organizationId, entityType, entityId, cursor, limit: COMMENT_PAGE_SIZE }),
    getMentionCandidates(organizationId),
  ]);

  // Newest-first from the query, reversed here for the oldest-first
  // conversational reading order this section alone uses.
  const comments = [...page.comments].reverse().map((comment) =>
    formatCommentViewModel({
      id: comment.id,
      authorId: comment.authorId,
      author: comment.author,
      body: comment.body,
      editedAt: comment.editedAt,
      deletedAt: comment.deletedAt,
      createdAt: comment.createdAt,
      mentions: comment.mentions,
    }),
  );

  return (
    <div className="mt-8 border-t border-gray-200 pt-6">
      <h2 className="text-lg font-semibold text-gray-900">Comments</h2>

      <div className="mt-4">
        <CommentComposer action={createAction} candidates={candidates} />
      </div>

      {page.cursorInvalid && (
        <p role="alert" className="mt-4 text-sm text-amber-700">
          Your previous comments page link expired — showing the latest comments instead.
        </p>
      )}

      {page.nextCursor && (
        <div className="mt-4 flex justify-center">
          <LoadMoreLink
            basePath={basePath}
            params={{}}
            cursor={page.nextCursor}
            cursorParam={cursorParam}
            label="Load earlier comments"
          />
        </div>
      )}

      <div className="mt-4">
        {comments.length === 0 ? (
          <EmptyState title="No comments yet" description={`Be the first to add one to this ${parentLabel}.`} />
        ) : (
          <CommentList
            comments={comments}
            currentUserId={currentUserId}
            isModerator={isModerator}
            candidates={candidates}
            makeEditAction={makeEditAction}
            makeDeleteAction={makeDeleteAction}
          />
        )}
      </div>
    </div>
  );
}
