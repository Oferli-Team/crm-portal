/**
 * Global Search Stage 2 (docs/search-architecture.md §4). The one response
 * shape every search consumer (the Route Handler, its tests, and — not yet
 * built — Stage 4's UI) agrees on. Deliberately narrower than any Prisma
 * row: every field here is already display-safe (bounded, allowlisted),
 * matching the same discipline Activity/Notification metadata already
 * enforce — organizationId, internal owner/staff ids, full Comment bodies,
 * notes, and Activity/Attachment internals are never part of this shape,
 * so a formatter cannot leak them even by accident.
 */
export type SearchResultType = "CLIENT" | "PROJECT" | "TASK" | "INVOICE" | "COMMENT";

export type SearchResult = {
  type: SearchResultType;
  id: string;
  title: string;
  subtitle: string | null;
  /** Comment body preview only (buildCommentPreview) — always null for every other type. */
  preview: string | null;
  /** Allowlisted, server-built relative path — see result-links.ts. Never a raw/stored URL. */
  url: string;
};

export type SearchResultGroup = {
  type: SearchResultType;
  items: SearchResult[];
};

export type SearchResponse = {
  query: string;
  groups: SearchResultGroup[];
};
