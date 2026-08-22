import { NextResponse } from "next/server";
import { getSearchRequestContext } from "@/lib/search/request-context";
import { searchOrganization } from "@/lib/search/search";
import { checkRateLimit, SEARCH_LIMIT, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit";

/**
 * Global Search Stage 2 (docs/search-architecture.md §4, and this stage's
 * own explicit route/response/auth contract). A plain JSON API — never a
 * page, never anything that redirects. `q` is the only client-supplied
 * input; `organizationId` is never accepted from the client at all (see
 * getSearchRequestContext).
 *
 * Deliberately no `limit` query parameter: the design doc's own §8 fixes
 * "top 5 per type" as a server-side constant, not something a caller can
 * widen.
 */
export async function GET(request: Request) {
  const context = await getSearchRequestContext();

  if (!context.ok) {
    const message = context.status === 401 ? "Not authenticated." : "Not authorized.";
    return NextResponse.json({ error: message }, { status: context.status });
  }

  const limitCheck = checkRateLimit(SEARCH_LIMIT, context.userId);
  if (limitCheck.limited) {
    // Never the scope name, the count, or the reset time — RATE_LIMIT_MESSAGE
    // is the one generic string every rate-limited route in this app returns.
    return NextResponse.json({ error: RATE_LIMIT_MESSAGE }, { status: 429 });
  }

  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";

  try {
    const result = await searchOrganization({ organizationId: context.organizationId, query: q });
    return NextResponse.json(result, {
      status: 200,
      headers: {
        // Search results are per-organization and per-user-scoped — never
        // cacheable by a shared/CDN cache, and never worth caching at all
        // given how quickly the underlying data changes.
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    // Never the real error's message or stack — see docs/search-
    // architecture.md §14. If a client aborts the underlying fetch, Next.js
    // simply has nowhere to send this response; the query itself already
    // completed (or fails here) independently of that, so an abort can
    // never crash or hang this handler.
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
