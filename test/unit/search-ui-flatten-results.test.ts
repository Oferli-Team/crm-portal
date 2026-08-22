import { describe, expect, it } from "vitest";
import {
  flattenSearchGroups,
  groupFlatResults,
  flatResultKey,
  clampActiveIndex,
  nextActiveIndex,
} from "@/lib/search-ui/flatten-results";
import type { SearchResultGroup } from "@/lib/search/types";

function makeResult(type: SearchResultGroup["type"], id: string) {
  return { type, id, title: `${type} ${id}`, subtitle: null, preview: null, url: `/x/${id}` };
}

describe("flattenSearchGroups — group ordering", () => {
  it("preserves the backend's own group order and assigns flatIndex in that order", () => {
    const groups: SearchResultGroup[] = [
      { type: "CLIENT", items: [makeResult("CLIENT", "c1")] },
      { type: "PROJECT", items: [makeResult("PROJECT", "p1"), makeResult("PROJECT", "p2")] },
      { type: "TASK", items: [] },
      { type: "INVOICE", items: [makeResult("INVOICE", "i1")] },
      { type: "COMMENT", items: [] },
    ];
    const flat = flattenSearchGroups(groups);
    expect(flat.map((r) => r.id)).toEqual(["c1", "p1", "p2", "i1"]);
    expect(flat.map((r) => r.flatIndex)).toEqual([0, 1, 2, 3]);
  });

  it("trusts each item's own type field rather than re-stamping from the group", () => {
    const groups: SearchResultGroup[] = [{ type: "CLIENT", items: [makeResult("CLIENT", "c1")] }];
    const flat = flattenSearchGroups(groups);
    expect(flat[0].type).toBe("CLIENT");
  });
});

describe("flattenSearchGroups — empty groups", () => {
  it("returns an empty array when every group is empty", () => {
    const groups: SearchResultGroup[] = [
      { type: "CLIENT", items: [] },
      { type: "PROJECT", items: [] },
      { type: "TASK", items: [] },
      { type: "INVOICE", items: [] },
      { type: "COMMENT", items: [] },
    ];
    expect(flattenSearchGroups(groups)).toEqual([]);
  });

  it("returns an empty array for an empty groups list", () => {
    expect(flattenSearchGroups([])).toEqual([]);
  });
});

describe("groupFlatResults", () => {
  it("re-buckets into the same groups with correct global flatIndex per item", () => {
    const groups: SearchResultGroup[] = [
      { type: "CLIENT", items: [makeResult("CLIENT", "c1"), makeResult("CLIENT", "c2")] },
      { type: "PROJECT", items: [] },
      { type: "TASK", items: [makeResult("TASK", "t1")] },
      { type: "INVOICE", items: [] },
      { type: "COMMENT", items: [] },
    ];
    const result = groupFlatResults(groups);
    expect(result.map((g) => g.type)).toEqual(["CLIENT", "PROJECT", "TASK", "INVOICE", "COMMENT"]);
    expect(result[0].items.map((i) => i.flatIndex)).toEqual([0, 1]);
    expect(result[2].items.map((i) => i.flatIndex)).toEqual([2]);
  });

  it("never mutates the input groups", () => {
    const groups: SearchResultGroup[] = [{ type: "CLIENT", items: [makeResult("CLIENT", "c1")] }];
    const copy = JSON.parse(JSON.stringify(groups));
    groupFlatResults(groups);
    expect(groups).toEqual(copy);
  });
});

describe("groupFlatResults — single source of truth with flattenSearchGroups", () => {
  it("its items, concatenated in group order, are exactly flattenSearchGroups's own output — same flatIndex per item, no duplicates, no drift between the two derivations", () => {
    const groups: SearchResultGroup[] = [
      { type: "CLIENT", items: [makeResult("CLIENT", "c1"), makeResult("CLIENT", "c2")] },
      { type: "PROJECT", items: [] },
      { type: "TASK", items: [makeResult("TASK", "t1")] },
      { type: "INVOICE", items: [makeResult("INVOICE", "i1"), makeResult("INVOICE", "i2")] },
      { type: "COMMENT", items: [makeResult("COMMENT", "cm1")] },
    ];

    const flat = flattenSearchGroups(groups);
    const grouped = groupFlatResults(groups);
    const reflattened = grouped.flatMap((group) => group.items);

    expect(reflattened).toEqual(flat);
    expect(new Set(reflattened.map((item) => item.flatIndex)).size).toBe(reflattened.length);
  });

  it("produces the same result on repeated calls with the same input (deterministic)", () => {
    const groups: SearchResultGroup[] = [
      { type: "CLIENT", items: [makeResult("CLIENT", "c1")] },
      { type: "PROJECT", items: [makeResult("PROJECT", "p1")] },
    ];
    expect(groupFlatResults(groups)).toEqual(groupFlatResults(groups));
  });
});

describe("flatResultKey", () => {
  it("produces a distinct key for the same id across different types (UUID collision safety)", () => {
    const sameId = "11111111-1111-1111-1111-111111111111";
    expect(flatResultKey({ type: "CLIENT", id: sameId })).not.toBe(flatResultKey({ type: "PROJECT", id: sameId }));
  });

  it("is deterministic for the same input", () => {
    const result = { type: "TASK" as const, id: "abc" };
    expect(flatResultKey(result)).toBe(flatResultKey(result));
  });
});

describe("clampActiveIndex", () => {
  it("clamps a negative index to 0 when the list is non-empty", () => {
    expect(clampActiveIndex(-1, 5)).toBe(0);
  });

  it("clamps an out-of-range index to the last valid index", () => {
    expect(clampActiveIndex(99, 5)).toBe(4);
  });

  it("returns -1 for an empty list regardless of the requested index", () => {
    expect(clampActiveIndex(0, 0)).toBe(-1);
    expect(clampActiveIndex(3, 0)).toBe(-1);
  });

  it("passes through an already-valid index unchanged", () => {
    expect(clampActiveIndex(2, 5)).toBe(2);
  });
});

describe("nextActiveIndex — boundary/wrap behavior", () => {
  it("wraps from the last item to the first on ArrowDown", () => {
    expect(nextActiveIndex(4, 5, 1)).toBe(0);
  });

  it("wraps from the first item to the last on ArrowUp", () => {
    expect(nextActiveIndex(0, 5, -1)).toBe(4);
  });

  it("moves forward by one in the middle of the list", () => {
    expect(nextActiveIndex(2, 5, 1)).toBe(3);
  });

  it("moves backward by one in the middle of the list", () => {
    expect(nextActiveIndex(2, 5, -1)).toBe(1);
  });

  it("starting from no selection (-1), ArrowDown lands on the first item", () => {
    expect(nextActiveIndex(-1, 5, 1)).toBe(0);
  });

  it("starting from no selection (-1), ArrowUp lands on the last item", () => {
    expect(nextActiveIndex(-1, 5, -1)).toBe(4);
  });

  it("returns -1 for an empty list regardless of direction", () => {
    expect(nextActiveIndex(-1, 0, 1)).toBe(-1);
    expect(nextActiveIndex(0, 0, -1)).toBe(-1);
  });

  it("is deterministic: repeated calls with the same input produce the same output", () => {
    expect(nextActiveIndex(2, 5, 1)).toBe(nextActiveIndex(2, 5, 1));
  });
});
