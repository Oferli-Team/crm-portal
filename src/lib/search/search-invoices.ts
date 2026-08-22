import { prisma } from "@/lib/prisma";
import { computeMatchTier, sortRanked } from "./ranking";
import { buildInvoiceResultUrl } from "./result-links";
import { escapeLikePattern } from "./normalize-query";
import type { SearchResult } from "./types";

/**
 * Global Search Stage 2 (docs/search-architecture.md §2/§5/§8). Scoped by
 * `organizationId` (required, kept consistent with project.organizationId
 * by every write path — matching the existing `buildInvoiceWhere`
 * convention exactly, src/app/(dashboard)/invoices/query.ts) as the primary
 * predicate, with BOTH `project: { organizationId }` and
 * `client: { organizationId }` retained as defense in depth — an Invoice's
 * Client and Project always belong to the same organization in valid data,
 * so requiring all three costs nothing on the happy path while refusing to
 * surface a row in the rare case those relations were ever inconsistent.
 *
 * Searches `invoiceNumber` and the related `Project.name`/`Client.name`
 * only — matching the design doc's §2 Scope exactly. `notes` is never
 * searched or selected: it is explicit free-text the design doc's §8 names
 * as never returned.
 */
export async function searchInvoices(params: {
  organizationId: string;
  query: string;
  candidateLimit: number;
  resultLimit: number;
}): Promise<SearchResult[]> {
  const escaped = escapeLikePattern(params.query);

  const rows = await prisma.invoice.findMany({
    where: {
      organizationId: params.organizationId,
      project: { organizationId: params.organizationId },
      client: { organizationId: params.organizationId },
      OR: [
        { invoiceNumber: { contains: escaped, mode: "insensitive" } },
        { project: { name: { contains: escaped, mode: "insensitive" } } },
        { project: { client: { name: { contains: escaped, mode: "insensitive" } } } },
      ],
    },
    select: {
      id: true,
      invoiceNumber: true,
      createdAt: true,
      project: { select: { name: true, client: { select: { name: true } } } },
    },
    take: params.candidateLimit,
    orderBy: { createdAt: "desc" },
  });

  const ranked = sortRanked(
    rows.map((row) => ({
      id: row.id,
      recencyKey: row.createdAt.toISOString(),
      tier: computeMatchTier({
        query: params.query,
        primary: row.invoiceNumber,
        secondary: `${row.project.name} ${row.project.client.name}`,
      }),
      row,
    })),
  );

  return ranked
    .slice(0, params.resultLimit)
    .map((entry): SearchResult | null => {
      const url = buildInvoiceResultUrl(entry.row.id);
      if (!url) return null;
      return {
        type: "INVOICE",
        id: entry.row.id,
        title: `Invoice #${entry.row.invoiceNumber}`,
        subtitle: `${entry.row.project.name} · ${entry.row.project.client.name}`,
        preview: null,
        url,
      };
    })
    .filter((result): result is SearchResult => result !== null);
}
