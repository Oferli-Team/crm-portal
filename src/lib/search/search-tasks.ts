import { prisma } from "@/lib/prisma";
import { computeMatchTier, sortRanked } from "./ranking";
import { buildTaskResultUrl } from "./result-links";
import { escapeLikePattern } from "./normalize-query";
import type { SearchResult } from "./types";

/**
 * Global Search Stage 2 (docs/search-architecture.md §2/§5/§7). Scoped
 * through `project: { organizationId }`, deliberately NOT `Task.organizationId`
 * directly — `Task.organizationId` is a nullable, denormalized convenience
 * column (see prisma/schema.prisma), and the existing `buildTaskWhere`
 * (src/app/(dashboard)/tasks/query.ts) already scopes through the Project
 * relation instead. Following any other convention here would risk a Task
 * whose own `organizationId` column happens to be null (a state the schema
 * allows) being silently excluded, or scoped inconsistently with every
 * other Task query in this app.
 *
 * Searches `title` and the related `Project.name` only — matching the
 * design doc's §2 Scope exactly ("Task — by title, and by its
 * Project.name"). `description` is not searched (not approved).
 */
export async function searchTasks(params: {
  organizationId: string;
  query: string;
  candidateLimit: number;
  resultLimit: number;
}): Promise<SearchResult[]> {
  const escaped = escapeLikePattern(params.query);

  const rows = await prisma.task.findMany({
    where: {
      project: { organizationId: params.organizationId },
      OR: [
        { title: { contains: escaped, mode: "insensitive" } },
        { project: { name: { contains: escaped, mode: "insensitive" } } },
      ],
    },
    select: {
      id: true,
      title: true,
      createdAt: true,
      project: { select: { name: true } },
    },
    take: params.candidateLimit,
    orderBy: { createdAt: "desc" },
  });

  const ranked = sortRanked(
    rows.map((row) => ({
      id: row.id,
      recencyKey: row.createdAt.toISOString(),
      tier: computeMatchTier({ query: params.query, primary: row.title, secondary: row.project.name }),
      row,
    })),
  );

  return ranked
    .slice(0, params.resultLimit)
    .map((entry): SearchResult | null => {
      const url = buildTaskResultUrl(entry.row.id);
      if (!url) return null;
      return {
        type: "TASK",
        id: entry.row.id,
        title: entry.row.title,
        subtitle: entry.row.project.name,
        preview: null,
        url,
      };
    })
    .filter((result): result is SearchResult => result !== null);
}
