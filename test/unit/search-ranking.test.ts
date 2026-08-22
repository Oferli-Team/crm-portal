import { describe, expect, it } from "vitest";
import { computeMatchTier, sortRanked, type MatchTier } from "@/lib/search/ranking";

describe("computeMatchTier — tier order", () => {
  it("exact match on the primary field is tier 1", () => {
    expect(computeMatchTier({ query: "acme", primary: "Acme" })).toBe(1);
  });

  it("prefix match on the primary field is tier 2", () => {
    expect(computeMatchTier({ query: "acme", primary: "Acme Corp" })).toBe(2);
  });

  it("contains match on the primary field (not a prefix) is tier 3", () => {
    expect(computeMatchTier({ query: "corp", primary: "Acme Corp" })).toBe(3);
  });

  it("contains match on the secondary field only is tier 4", () => {
    expect(computeMatchTier({ query: "corp", primary: "Onboarding", secondary: "Acme Corp" })).toBe(4);
  });

  it("no match anywhere is null", () => {
    expect(computeMatchTier({ query: "zzz", primary: "Acme", secondary: "Corp" })).toBeNull();
  });

  it("a primary-field match always wins over a secondary-field match, even if the secondary would rank higher on its own", () => {
    // "acme" is an exact match on secondary but only a contains match on primary — primary tier wins.
    const tier = computeMatchTier({ query: "acme", primary: "Not Acme At All", secondary: "acme" });
    expect(tier).toBe(3);
  });
});

describe("computeMatchTier — case-insensitivity", () => {
  it("matches regardless of query case", () => {
    expect(computeMatchTier({ query: "ACME", primary: "acme corp" })).toBe(2);
  });

  it("matches regardless of primary-field case", () => {
    expect(computeMatchTier({ query: "acme", primary: "ACME CORP" })).toBe(2);
  });
});

describe("sortRanked — tier ordering", () => {
  it("sorts strictly by tier ascending (1 first)", () => {
    const input = [
      { id: "c", tier: 3 as MatchTier, recencyKey: "2024-01-01T00:00:00.000Z" },
      { id: "a", tier: 1 as MatchTier, recencyKey: "2024-01-01T00:00:00.000Z" },
      { id: "b", tier: 2 as MatchTier, recencyKey: "2024-01-01T00:00:00.000Z" },
    ];
    expect(sortRanked(input).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("drops candidates with a null tier", () => {
    const input = [
      { id: "a", tier: 1 as MatchTier, recencyKey: "2024-01-01T00:00:00.000Z" },
      { id: "b", tier: null, recencyKey: "2024-01-01T00:00:00.000Z" },
    ];
    expect(sortRanked(input).map((c) => c.id)).toEqual(["a"]);
  });
});

describe("sortRanked — deterministic tie-break", () => {
  it("breaks a tier tie by recency, newest first", () => {
    const input = [
      { id: "older", tier: 1 as MatchTier, recencyKey: "2024-01-01T00:00:00.000Z" },
      { id: "newer", tier: 1 as MatchTier, recencyKey: "2024-06-01T00:00:00.000Z" },
    ];
    expect(sortRanked(input).map((c) => c.id)).toEqual(["newer", "older"]);
  });

  it("breaks a full tie (same tier, same recency) by id, descending — stable and deterministic", () => {
    const input = [
      { id: "aaaa", tier: 1 as MatchTier, recencyKey: "2024-01-01T00:00:00.000Z" },
      { id: "bbbb", tier: 1 as MatchTier, recencyKey: "2024-01-01T00:00:00.000Z" },
    ];
    const first = sortRanked(input).map((c) => c.id);
    const second = sortRanked(input).map((c) => c.id);
    expect(first).toEqual(second); // stable across repeated calls on the same data
    expect(first).toEqual(["bbbb", "aaaa"]);
  });

  it("never mutates the input array", () => {
    const input = [
      { id: "b", tier: 2 as MatchTier, recencyKey: "2024-01-01T00:00:00.000Z" },
      { id: "a", tier: 1 as MatchTier, recencyKey: "2024-01-01T00:00:00.000Z" },
    ];
    const copy = [...input];
    sortRanked(input);
    expect(input).toEqual(copy);
  });
});

describe("sortRanked — duplicate candidates", () => {
  it("keeps duplicate ids as separate entries — de-duplication is the caller's own concern, not ranking's", () => {
    const input = [
      { id: "same", tier: 1 as MatchTier, recencyKey: "2024-01-01T00:00:00.000Z" },
      { id: "same", tier: 2 as MatchTier, recencyKey: "2024-01-01T00:00:00.000Z" },
    ];
    expect(sortRanked(input)).toHaveLength(2);
  });
});
