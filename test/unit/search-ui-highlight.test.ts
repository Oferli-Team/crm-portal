import { describe, expect, it } from "vitest";
import { buildHighlightSegments } from "@/lib/search-ui/highlight";

describe("buildHighlightSegments — exact match", () => {
  it("highlights the whole string when it exactly equals the query", () => {
    expect(buildHighlightSegments("Acme", "Acme")).toEqual([{ text: "Acme", match: true }]);
  });

  it("highlights a substring in the middle of a longer string", () => {
    expect(buildHighlightSegments("Acme Corp Industries", "Corp")).toEqual([
      { text: "Acme ", match: false },
      { text: "Corp", match: true },
      { text: " Industries", match: false },
    ]);
  });
});

describe("buildHighlightSegments — case-insensitivity", () => {
  it("matches regardless of query case", () => {
    expect(buildHighlightSegments("Acme Corp", "corp")).toEqual([
      { text: "Acme ", match: false },
      { text: "Corp", match: true },
    ]);
  });

  it("matches regardless of text case, preserving the original text's own case in the output", () => {
    expect(buildHighlightSegments("ACME CORP", "acme")).toEqual([
      { text: "ACME", match: true },
      { text: " CORP", match: false },
    ]);
  });
});

describe("buildHighlightSegments — multiple occurrences", () => {
  it("highlights every non-overlapping occurrence", () => {
    expect(buildHighlightSegments("ababab", "ab")).toEqual([
      { text: "ab", match: true },
      { text: "ab", match: true },
      { text: "ab", match: true },
    ]);
  });

  it("does not double-count overlapping occurrences (moves the cursor past each match)", () => {
    expect(buildHighlightSegments("aaaa", "aa")).toEqual([
      { text: "aa", match: true },
      { text: "aa", match: true },
    ]);
  });
});

describe("buildHighlightSegments — special characters are treated as literal text, never as regex", () => {
  it("a query containing regex metacharacters matches only the literal substring", () => {
    expect(buildHighlightSegments("50% off (limited)", "50%")).toEqual([
      { text: "50%", match: true },
      { text: " off (limited)", match: false },
    ]);
  });

  it("a query that would be an invalid/dangerous regex pattern never throws", () => {
    const adversarialQueries = ["(", "[", "*", "\\", "(a+)+", ".*", "a{999999999}"];
    for (const query of adversarialQueries) {
      expect(() => buildHighlightSegments("some (a+)+ text with [brackets] and *stars*", query)).not.toThrow();
    }
  });

  it("a literal underscore/percent/backslash in the source text is highlighted correctly when the query matches it verbatim", () => {
    expect(buildHighlightSegments("file_name.txt", "file_name")).toEqual([
      { text: "file_name", match: true },
      { text: ".txt", match: false },
    ]);
  });
});

describe("buildHighlightSegments — unicode", () => {
  it("highlights a non-Latin-script match correctly", () => {
    expect(buildHighlightSegments("プロジェクト日本語", "日本語")).toEqual([
      { text: "プロジェクト", match: false },
      { text: "日本語", match: true },
    ]);
  });

  it("handles emoji/astral characters without throwing or corrupting output", () => {
    expect(() => buildHighlightSegments("Project 🚀 Launch", "🚀")).not.toThrow();
  });
});

describe("buildHighlightSegments — empty query", () => {
  it("returns the whole text as a single non-matching segment for an empty query", () => {
    expect(buildHighlightSegments("Acme Corp", "")).toEqual([{ text: "Acme Corp", match: false }]);
  });

  it("returns the whole text as non-matching for a whitespace-only query", () => {
    expect(buildHighlightSegments("Acme Corp", "   ")).toEqual([{ text: "Acme Corp", match: false }]);
  });
});

describe("buildHighlightSegments — no match", () => {
  it("returns the whole text as a single non-matching segment when the query never appears", () => {
    expect(buildHighlightSegments("Acme Corp", "zzz")).toEqual([{ text: "Acme Corp", match: false }]);
  });
});

describe("buildHighlightSegments — empty text", () => {
  it("returns an empty array for empty text, regardless of query", () => {
    expect(buildHighlightSegments("", "acme")).toEqual([]);
    expect(buildHighlightSegments("", "")).toEqual([]);
  });
});

describe("buildHighlightSegments — never produces HTML/markup", () => {
  it("a text containing script-tag-shaped content is only ever split into plain segments, never interpreted", () => {
    const segments = buildHighlightSegments("<script>alert(1)</script>", "script");
    const joined = segments.map((s) => s.text).join("");
    expect(joined).toBe("<script>alert(1)</script>");
    expect(segments.every((s) => typeof s.text === "string")).toBe(true);
  });
});
