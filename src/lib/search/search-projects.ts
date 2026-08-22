import { prisma } from "@/lib/prisma";
import { computeMatchTier, sortRanked } from "./ranking";
import { buildProjectResultUrl } from "./result-links";
import { escapeLikePattern } from "./normalize-query";
import type { SearchResult } from "./types";

/**
 * Global Search Stage 2 (docs/search-architecture.md §2/§5/§6). Searches
 * `name` and the related `Client.name` only — matching the design doc's
 * §2 Scope exactly ("Project — by name, and by its Client.name") and the
 * existing `buildProjectWhere` convention. `description` is deliberately
 * NOT searched: the design doc's own Scope section never approved it, and
 * §6 explicitly calls out never returning "internal IDs or client-sensitive
 * fields beyond subtitle" — `budget`/`ownerId` are never selected here at
 * all.
 */
export async function searchProjects(params: {
  organizationId: string;
  query: string;
  candidateLimit: number;
  resultLimit: number;
}): Promise<SearchResult[]> {
  const escaped = escapeLikePattern(params.query);

  const rows = await prisma.project.findMany({
    where: {
      organizationId: params.organizationId,
      OR: [
        { name: { contains: escaped, mode: "insensitive" } },
        { client: { name: { contains: escaped, mode: "insensitive" } } },
      ],
    },
    select: {
      id: true,
      name: true,
      createdAt: true,
      client: { select: { name: true } },
    },
    take: params.candidateLimit,
    orderBy: { createdAt: "desc" },
  });

  const ranked = sortRanked(
    rows.map((row) => ({
      id: row.id,
      recencyKey: row.createdAt.toISOString(),
      tier: computeMatchTier({ query: params.query, primary: row.name, secondary: row.client.name }),
      row,
    })),
  );

  return ranked
    .slice(0, params.resultLimit)
    .map((entry): SearchResult | null => {
      const url = buildProjectResultUrl(entry.row.id);
      if (!url) return null;
      return {
        type: "PROJECT",
        id: entry.row.id,
        title: entry.row.name,
        subtitle: entry.row.client.name,
        preview: null,
        url,
      };
    })
    .filter((result): result is SearchResult => result !== null);
}
