import { CommentItem } from "./comment-item";
import { resolveCommentPermissions, type CommentViewModel } from "@/lib/comments/format-comment";
import type { MentionCandidate } from "@/lib/comments/mention-candidates";
import type { CommentActionState } from "@/types";

/**
 * Comments & Mentions Stage 4 — a plain list, no client state of its own
 * (each row owns its own edit-mode state, see CommentItem). Rendered
 * oldest-first (docs/comments-architecture.md §6: "the opposite display
 * order from Activity/Notifications' own newest-first feed") — the page
 * fetched newest-first via getCommentsPage's own keyset order and already
 * reversed it before this component ever sees the list.
 */
export function CommentList({
  comments,
  currentUserId,
  isModerator,
  candidates,
  makeEditAction,
  makeDeleteAction,
}: {
  comments: CommentViewModel[];
  currentUserId: string;
  isModerator: boolean;
  candidates: MentionCandidate[];
  makeEditAction: (commentId: string) => (prevState: CommentActionState, formData: FormData) => Promise<CommentActionState>;
  makeDeleteAction: (commentId: string) => () => Promise<void>;
}) {
  return (
    <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
      {comments.map((comment) => {
        const { canEdit, canDelete } = resolveCommentPermissions(comment, currentUserId, isModerator);
        return (
          <CommentItem
            key={comment.id}
            comment={comment}
            canEdit={canEdit}
            canDelete={canDelete}
            candidates={candidates}
            editAction={makeEditAction(comment.id)}
            deleteAction={makeDeleteAction(comment.id)}
          />
        );
      })}
    </ul>
  );
}
