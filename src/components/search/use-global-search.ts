"use client";

import { useEffect, useRef, useState } from "react";
import { SEARCH_QUERY_MIN_LENGTH } from "@/lib/search/normalize-query";
import { buildSearchOutcome, type SearchOutcome } from "@/lib/search-ui/response-mapping";
import { flattenSearchGroups, clampActiveIndex, nextActiveIndex, type FlatSearchResult } from "@/lib/search-ui/flatten-results";
import type { SearchResultGroup } from "@/lib/search/types";

/** ~200-250ms, per docs/search-architecture.md §3 — a plain setTimeout, no debounce library, matching this app's zero-dependency posture everywhere else. */
const DEBOUNCE_MS = 250;

export type GlobalSearchPhase = "idle" | "loading" | "results" | "unauthorized" | "rate_limited" | "error";

export type GlobalSearchState = {
  query: string;
  phase: GlobalSearchPhase;
  groups: SearchResultGroup[];
  flatResults: FlatSearchResult[];
  activeIndex: number;
  /** Only set for phase "rate_limited" — the backend's own generic message, passed through verbatim. */
  message: string | null;
};

const INITIAL_STATE: GlobalSearchState = {
  query: "",
  phase: "idle",
  groups: [],
  flatResults: [],
  activeIndex: -1,
  message: null,
};

/**
 * Global Search Stage 3's one fetch/state orchestrator — every other piece
 * (highlight, flatten/navigation, response mapping) is a pure function this
 * hook composes, never logic duplicated here. Deliberately a Route Handler
 * `fetch()`, never a Server Action (see docs/search-architecture.md §4's
 * own reasoning: a live, cancel-and-replace, debounced read is shaped like
 * a plain abortable fetch, not a discrete user action).
 */
export function useGlobalSearch() {
  const [state, setState] = useState<GlobalSearchState>(INITIAL_STATE);

  // A monotonically increasing id, not just the AbortController's own
  // signal, so a stale response is ignored even if something in the fetch
  // chain (a test harness, a misbehaving polyfill) doesn't fully honor
  // abort() — belt and suspenders over "stale response never overwrites a
  // newer query's results" (docs/search-architecture.md §3).
  const requestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function runSearch(query: string) {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    requestIdRef.current += 1;
    const thisRequestId = requestIdRef.current;

    setState((prev) => ({ ...prev, phase: "loading" }));

    let outcome: SearchOutcome;
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
        // Deliberately no headers/credentials override — this is a plain
        // same-origin GET relying on the browser's own cookie jar, the
        // same way every other same-origin fetch in this app already
        // would (see docs/search-architecture.md §14: organizationId is
        // never sent by the client, only resolved server-side from the
        // session cookie).
      });
      const body: unknown = await response.json().catch(() => null);
      outcome = buildSearchOutcome(response.status, body);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Expected: a newer keystroke superseded this request. Never a
        // user-visible error — just stop here, the newer request's own
        // completion (or lack thereof) owns the state from here on.
        return;
      }
      outcome = { kind: "error" };
    }

    if (requestIdRef.current !== thisRequestId) {
      // A newer request already started (or the dialog/organization was
      // reset) before this one resolved — discard silently, never
      // overwrite fresher state with a stale response.
      return;
    }

    if (outcome.kind === "success") {
      const flatResults = flattenSearchGroups(outcome.groups);
      setState((prev) => ({
        ...prev,
        phase: "results",
        groups: outcome.groups,
        flatResults,
        // Auto-highlights the first result so "type, then Enter" works
        // without an extra ArrowDown — but never auto-selects into an
        // empty result set.
        activeIndex: flatResults.length > 0 ? 0 : -1,
        message: null,
      }));
    } else if (outcome.kind === "rate_limited") {
      setState((prev) => ({
        ...prev,
        phase: "rate_limited",
        groups: [],
        flatResults: [],
        activeIndex: -1,
        message: outcome.message,
      }));
    } else {
      setState((prev) => ({
        ...prev,
        phase: outcome.kind,
        groups: [],
        flatResults: [],
        activeIndex: -1,
        message: null,
      }));
    }
  }

  /**
   * The user-input event handler itself (called from the input's
   * onChange — a real DOM event, never a `useEffect` body) — this is
   * where the "query too short: cancel in-flight work and fall back to
   * idle" transition is decided and applied synchronously, in one
   * `setState` call tied directly to the keystroke that caused it. Kept
   * out of the effect below entirely so that effect never needs to call
   * `setState` synchronously from its own top-level body (React's
   * `react-hooks/set-state-in-effect` rule) — the same fix Comments &
   * Mentions' own composer reset used: route a state transition through
   * a real event instead of an effect body.
   */
  function setQuery(rawQuery: string) {
    const trimmed = rawQuery.trim();
    if (trimmed.length < SEARCH_QUERY_MIN_LENGTH) {
      if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current);
      abortControllerRef.current?.abort();
      requestIdRef.current += 1;
      setState({ ...INITIAL_STATE, query: rawQuery });
      return;
    }
    setState((prev) => ({ ...prev, query: rawQuery }));
  }

  /** Discards any in-flight request and pending debounce timer, and resets to the closed/empty state — called on dialog close and on an active-organization change (see global-search.tsx). */
  function reset() {
    if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current);
    abortControllerRef.current?.abort();
    requestIdRef.current += 1;
    setState(INITIAL_STATE);
  }

  useEffect(() => {
    // setQuery() already handled the "too short" transition synchronously,
    // as part of the same keystroke event — by the time this effect runs,
    // a too-short query has nothing left for it to do. This effect's only
    // remaining job is arming the debounce timer for a long-enough query;
    // the one setState call that eventually follows happens inside the
    // setTimeout callback (deferred, not synchronous-in-effect), which is
    // exactly what an effect is for: reacting to a value with an external
    // timer.
    const trimmed = state.query.trim();
    if (trimmed.length < SEARCH_QUERY_MIN_LENGTH) {
      return;
    }

    const timeoutId = setTimeout(() => {
      void runSearch(trimmed);
    }, DEBOUNCE_MS);
    debounceTimeoutRef.current = timeoutId;

    return () => clearTimeout(timeoutId);
  }, [state.query]);

  function moveActive(direction: 1 | -1) {
    setState((prev) => ({ ...prev, activeIndex: nextActiveIndex(prev.activeIndex, prev.flatResults.length, direction) }));
  }

  function setActiveByHover(flatIndex: number) {
    setState((prev) => ({ ...prev, activeIndex: clampActiveIndex(flatIndex, prev.flatResults.length) }));
  }

  return { state, setQuery, reset, moveActive, setActiveByHover };
}
