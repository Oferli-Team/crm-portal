import { prisma } from "@/lib/prisma";
import { buildCommentPreview } from "@/lib/comments/preview";
import { relativeTime } from "@/lib/notifications/relative-time";
import { sortRanked } from "./ranking";
import { buildCommentResultUrl, type CommentParentType } from "./result-links";
import { escapeLikePattern } from "./normalize-query";
import type { SearchResult } from "./types";

/** Matches src/lib/comments/format-comment.ts's own (non-exported) constant exactly — kept as a small, independent local copy rather than exporting a private string from a sibling feature just for this one reuse. */
const DELETED_AUTHOR_LABEL = "Deleted user";

/**
 * Global Search Stage 2 (docs/search-architecture.md §9). Searches `body`
 * only, and only among comments not soft-deleted
 * (`deletedAt: null` — stricter than the Comments UI itself, which still
 * shows a placeholder for a deleted row; search omits it entirely, see the
 * design doc's own reasoning). Never returns the full body: `preview` is
 * always `buildCommentPreview(body)` — the same bounded (140 char),
 * whitespace-collapsing, mention-token-stripping function Activity and
 * Notification metadata already reuse; this is its third consumer, not a
 * new implementation.
 *
 * `Comment.entityId` is not a foreign key (see prisma/schema.prisma's own
 * comment on this) — a comment's parent Project/Task must be re-verified
 * to actually belong to `organizationId` before it is ever surfaced here,
 * matching `resolveCommentTarget`'s own "ownership is an application-layer
 * check, not a schema guarantee" discipline. This is done via exactly two
 * extra bounded queries (one for all candidate PROJECT parents, one for all
 * candidate TASK parents) — never a per-row lookup — so this stays three
 * queries total regardless of how many comment candidates were found, not
 * an N+1.
 */
export async function searchComments(params: {
  organizationId: string;
  query: string;
  candidateLimit: number;
  resultLimit: number;
}): Promise<SearchResult[]> {
  const escaped = escapeLikePattern(params.query);

  const rows = await prisma.comment.findMany({
    where: {
      organizationId: params.organizationId,
      deletedAt: null,
      body: { contains: escaped, mode: "insensitive" },
    },
    select: {
      id: true,
      body: true,
      entityType: true,
      entityId: true,
      createdAt: true,
      author: { select: { name: true } },
    },
    take: params.candidateLimit,
    orderBy: { createdAt: "desc" },
  });

  if (rows.length === 0) return [];

  const projectIds = rows.filter((r) => r.entityType === "PROJECT").map((r) => r.entityId);
  const taskIds = rows.filter((r) => r.entityType === "TASK").map((r) => r.entityId);

  const [projects, tasks] = await Promise.all([
    projectIds.length > 0
      ? prisma.project.findMany({
          where: { id: { in: projectIds }, organizationId: params.organizationId },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    taskIds.length > 0
      ? prisma.task.findMany({
          where: { id: { in: taskIds }, project: { organizationId: params.organizationId } },
          select: { id: true, title: true },
        })
      : Promise.resolve([]),
  ]);

  const projectLabelById = new Map(projects.map((p) => [p.id, p.name]));
  const taskLabelById = new Map(tasks.map((t) => [t.id, t.title]));

  const candidates = rows
    .map((row) => {
      const parentType = row.entityType as CommentParentType;
      const parentLabel =
        parentType === "PROJECT" ? projectLabelById.get(row.entityId) : taskLabelById.get(row.entityId);
      // The comment's own organizationId matched, but its entityId doesn't
      // resolve to a real Project/Task actually in this org (or at all) —
      // never surface it. See this module's own header comment.
      if (!parentLabel) return null;

      const url = buildCommentResultUrl(parentType, row.entityId, row.id);
      if (!url) return null;

      // Comments have no "title" of their own to rank exact/prefix
      // against (see docs/search-architecture.md §5: "a Comment result's
      // rank is body-contains-query only, roughly tier-3 equivalent") —
      // every candidate here already matched the DB's own `contains`
      // filter against the raw body, so it's always tier 3, deliberately
      // never computed against the (possibly-truncated) preview, which
      // could otherwise miss a match that only appears past the preview's
      // own 140-character cutoff.
      const tier = 3 as const;
      const preview = buildCommentPreview(row.body);

      return { row, parentLabel, url, preview, tier };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const ranked = sortRanked(
    candidates.map((c) => ({
      id: c.row.id,
      recencyKey: c.row.createdAt.toISOString(),
      tier: c.tier,
      candidate: c,
    })),
  );

  return ranked.slice(0, params.resultLimit).map(({ candidate }) => ({
    type: "COMMENT" as const,
    id: candidate.row.id,
    title: candidate.parentLabel,
    subtitle: `${candidate.row.author?.name ?? DELETED_AUTHOR_LABEL} · ${relativeTime(candidate.row.createdAt)}`,
    preview: candidate.preview,
    url: candidate.url,
  }));
}
