import type { SearchResult, SearchResultGroup, SearchResultType } from "@/lib/search/types";

/**
 * Global Search Stage 3 (docs/search-architecture.md §14, and this stage's
 * own explicit state contract). Pure — takes an already-parsed HTTP status
 * and JSON body, never a real `Response`/`fetch` call itself (that lives in
 * use-global-search.ts, where it's exercised end-to-end by the E2E suite
 * rather than a unit test — this project has no component/DOM-rendering
 * test infrastructure, see the Stage 3 report). Never re-derives ranking —
 * a 200 body's groups/items are only ever filtered (never reordered or
 * re-sorted) by `sanitizeSearchGroups` below, so the backend's own group
 * and item order (§7's ranking contract) is always preserved.
 */
export type SearchOutcome =
  | { kind: "success"; groups: SearchResultGroup[] }
  | { kind: "unauthorized" }
  | { kind: "rate_limited"; message: string }
  | { kind: "error" };

/** Never the real 401/403 body text ("Not authenticated."/"Not authorized.") — a signed-in staff user seeing an auth-flavored error inside a search box mid-keystroke would read as alarming/confusing for what's almost always a rare, transient session hiccup. */
export const SEARCH_UNAUTHORIZED_MESSAGE = "Something went wrong. Please refresh the page.";

/** Never the real 500 body text — a generic, never-Prisma, never-stack message, per docs/search-architecture.md §14. Also what a 200 response degrades to when its body is malformed badly enough that showing whatever survived would be misleading — see sanitizeSearchGroups. */
export const SEARCH_GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

/** Matches the backend's own RATE_LIMIT_MESSAGE (src/lib/rate-limit/index.ts) verbatim — kept as an independent client-side copy rather than importing a server module into the client bundle just for one string constant; used only as a fallback if the response body is ever unparseable. */
const RATE_LIMIT_FALLBACK_MESSAGE = "Too many requests. Please try again later.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const SEARCH_RESULT_TYPES: readonly SearchResultType[] = ["CLIENT", "PROJECT", "TASK", "INVOICE", "COMMENT"];

function isSearchResultType(value: unknown): value is SearchResultType {
  return typeof value === "string" && (SEARCH_RESULT_TYPES as readonly string[]).includes(value);
}

/** `search.ts` always sends `subtitle`/`preview` as `string | null` (never omitted), but this is untrusted input — a missing key is tolerated exactly like an explicit `null` rather than rejecting the whole item over it. */
function isNullableString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === "string";
}

/**
 * Rebuilds one item from only its known, expected fields — `type`/`id`/
 * `title`/`url` are required strings (with `type` further constrained to
 * the five known values), `subtitle`/`preview` are string-or-null. Any
 * other field on the raw object (an internal id, a future field this
 * client doesn't know about yet, anything) is never copied into the
 * result — ignored by construction, not by an explicit denylist. Returns
 * `null` if any required field fails validation, signaling the caller to
 * drop just this one item.
 */
function sanitizeSearchResult(value: unknown): SearchResult | null {
  if (!isRecord(value)) return null;
  if (!isSearchResultType(value.type)) return null;
  if (typeof value.id !== "string") return null;
  if (typeof value.title !== "string") return null;
  if (typeof value.url !== "string") return null;
  if (!isNullableString(value.subtitle)) return null;
  if (!isNullableString(value.preview)) return null;

  return {
    type: value.type,
    id: value.id,
    title: value.title,
    subtitle: value.subtitle ?? null,
    preview: value.preview ?? null,
    url: value.url,
  };
}

/** Same "rebuild from known fields, drop on any mismatch" treatment as `sanitizeSearchResult`, one level up. A malformed `items` (missing/not an array) drops the whole group — there's no meaningful subset of a group whose own item list isn't a list. */
function sanitizeSearchResultGroup(value: unknown): SearchResultGroup | null {
  if (!isRecord(value)) return null;
  if (!isSearchResultType(value.type)) return null;
  if (!Array.isArray(value.items)) return null;

  const items: SearchResult[] = [];
  for (const rawItem of value.items) {
    const item = sanitizeSearchResult(rawItem);
    // A single malformed item is dropped, not escalated to a generic
    // error — see this function's own all-dropped guard below for the
    // one case where that same tolerance would itself mask a systemic
    // contract break instead of one bad row.
    if (item) items.push(item);
  }

  return { type: value.type, items };
}

/**
 * Validates/sanitizes a 200 response's `groups` field. Returns `null`
 * (→ the caller maps this to a generic error, never a silently-empty
 * result) when the shape is broken badly enough that showing whatever
 * survived would be misleading:
 *  - `rawGroups` isn't an array at all (the top-level contract itself is
 *    broken), or
 *  - `rawGroups` was non-empty but every single entry failed validation —
 *    a real backend response is either `[]` (searchOrganization's own
 *    "query too short, no search yet" shape — see search.ts) or exactly
 *    five group objects; an "every entry malformed" result is far more
 *    likely a systemic contract mismatch than five simultaneously-corrupt
 *    rows, and silently reducing it to `[]` would be indistinguishable
 *    from "searched, found nothing."
 *
 * Otherwise returns the surviving groups/items, in their original order
 * — malformed groups or malformed items within an otherwise-valid group
 * are silently dropped, tolerating a single bad row without treating it
 * as "the whole subsystem is down." Never reorders, never re-derives
 * ranking — only filters.
 */
function sanitizeSearchGroups(rawGroups: unknown): SearchResultGroup[] | null {
  if (!Array.isArray(rawGroups)) return null;
  if (rawGroups.length === 0) return [];

  const groups: SearchResultGroup[] = [];
  for (const rawGroup of rawGroups) {
    const group = sanitizeSearchResultGroup(rawGroup);
    if (group) groups.push(group);
  }

  if (groups.length === 0) return null;

  return groups;
}

export function buildSearchOutcome(status: number, body: unknown): SearchOutcome {
  if (status === 200) {
    const groups = isRecord(body) ? sanitizeSearchGroups(body.groups) : null;
    return groups === null ? { kind: "error" } : { kind: "success", groups };
  }

  if (status === 401 || status === 403) {
    return { kind: "unauthorized" };
  }

  if (status === 429) {
    const message = isRecord(body) && typeof body.error === "string" ? body.error : RATE_LIMIT_FALLBACK_MESSAGE;
    return { kind: "rate_limited", message };
  }

  return { kind: "error" };
}
