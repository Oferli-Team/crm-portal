import { prisma } from "@/lib/prisma";
import { computeMatchTier, sortRanked } from "./ranking";
import { buildClientResultUrl } from "./result-links";
import { escapeLikePattern } from "./normalize-query";
import type { SearchResult } from "./types";

/**
 * Global Search Stage 2 (docs/search-architecture.md §2/§5). Searches
 * `name`, `company`, `email` only — exactly the fields the design doc
 * approved and the existing `buildClientWhere` (src/app/(dashboard)/clients/
 * query.ts) already searches. Deliberately never `notes` (a free-text field
 * that can hold anything a staff user privately jotted down about a
 * client — well outside what a global search result should ever surface)
 * and never `phone`/`status` (not approved by the design doc).
 *
 * `name` is the ranked primary field; `company`/`email` together are the
 * one secondary field ranking checks (see computeMatchTier) — the same
 * "primary title + one related/contextual field" shape the design doc
 * fixed for every entity type.
 */
export async function searchClients(params: {
  organizationId: string;
  query: string;
  candidateLimit: number;
  resultLimit: number;
}): Promise<SearchResult[]> {
  const escaped = escapeLikePattern(params.query);

  const rows = await prisma.client.findMany({
    where: {
      organizationId: params.organizationId,
      OR: [
        { name: { contains: escaped, mode: "insensitive" } },
        { company: { contains: escaped, mode: "insensitive" } },
        { email: { contains: escaped, mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true, company: true, email: true, createdAt: true },
    take: params.candidateLimit,
    orderBy: { createdAt: "desc" },
  });

  const ranked = sortRanked(
    rows.map((row) => ({
      id: row.id,
      recencyKey: row.createdAt.toISOString(),
      tier: computeMatchTier({
        query: params.query,
        primary: row.name,
        secondary: [row.company, row.email].filter(Boolean).join(" "),
      }),
      row,
    })),
  );

  return ranked
    .slice(0, params.resultLimit)
    .map((entry): SearchResult | null => {
      const url = buildClientResultUrl(entry.row.id);
      if (!url) return null;
      return {
        type: "CLIENT",
        id: entry.row.id,
        title: entry.row.name,
        subtitle: entry.row.company ?? entry.row.email ?? null,
        preview: null,
        url,
      };
    })
    .filter((result): result is SearchResult => result !== null);
}
