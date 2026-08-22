import { normalizeSearchQuery } from "./normalize-query";
import { searchClients } from "./search-clients";
import { searchProjects } from "./search-projects";
import { searchTasks } from "./search-tasks";
import { searchInvoices } from "./search-invoices";
import { searchComments } from "./search-comments";
import type { SearchResponse } from "./types";

/**
 * Global Search Stage 2 (docs/search-architecture.md §4/§8/§11). The one
 * entry point every caller (the Route Handler, and its own tests) uses —
 * never one of the five search-*.ts functions directly outside this file's
 * own composition.
 */

/**
 * How many rows each per-type query is allowed to pull from the database
 * before in-memory ranking runs — not the number of results shown. Bounded
 * deliberately: Postgres cannot express this app's own tiered ranking
 * (exact/prefix/contains/secondary-field) as a single, cheap `ORDER BY`
 * without a dedicated relevance extension this stage explicitly does not
 * introduce (see docs/search-architecture.md §7) — so ranking happens in
 * application code, and it only ever operates on this many rows per type,
 * never an unbounded `findMany`.
 */
const CANDIDATE_LIMIT_PER_TYPE = 30;

/** How many ranked results are actually returned per type — the design doc's own "top 5 per type" figure (§8). */
const DEFAULT_RESULT_LIMIT_PER_TYPE = 5;

export async function searchOrganization(params: {
  organizationId: string;
  query: string;
}): Promise<SearchResponse> {
  const normalized = normalizeSearchQuery(params.query);
  if (!normalized.ok) {
    // Below the minimum length (including empty) — this is "no search yet,"
    // not an error: a stable 200 with a genuinely empty groups array (never
    // the five per-type groups with empty items each — that shape is
    // reserved for "searched, found nothing," a different state).
    return { query: "", groups: [] };
  }

  const shared = {
    organizationId: params.organizationId,
    query: normalized.value,
    candidateLimit: CANDIDATE_LIMIT_PER_TYPE,
    resultLimit: DEFAULT_RESULT_LIMIT_PER_TYPE,
  };

  // Deliberately Promise.all, not Promise.allSettled: if one per-type query
  // ever throws, the whole request fails (surfaced as the Route Handler's
  // generic 500 — see route.ts) rather than silently returning a partial
  // result with an unexplained missing category. All five queries are
  // lightweight, equally-shaped reads against the same database — in
  // practice a failure in one overwhelmingly means a real, shared problem
  // (a connection issue), not something isolated to that one entity type,
  // so pretending to gracefully degrade would mostly just hide a real bug
  // from both the user and monitoring. This mirrors how CommentsSection's
  // own two parallel queries never attempt partial degradation either.
  const [clients, projects, tasks, invoices, comments] = await Promise.all([
    searchClients(shared),
    searchProjects(shared),
    searchTasks(shared),
    searchInvoices(shared),
    searchComments(shared),
  ]);

  return {
    query: normalized.value,
    groups: [
      { type: "CLIENT", items: clients },
      { type: "PROJECT", items: projects },
      { type: "TASK", items: tasks },
      { type: "INVOICE", items: invoices },
      { type: "COMMENT", items: comments },
    ],
  };
}
