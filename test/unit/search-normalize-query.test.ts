import { describe, expect, it } from "vitest";
import {
  normalizeSearchQuery,
  escapeLikePattern,
  SEARCH_QUERY_MIN_LENGTH,
  SEARCH_QUERY_MAX_LENGTH,
} from "@/lib/search/normalize-query";

describe("normalizeSearchQuery — trimming and whitespace", () => {
  it("trims leading/trailing whitespace", () => {
    expect(normalizeSearchQuery("  acme  ")).toEqual({ ok: true, value: "acme" });
  });

  it("collapses internal runs of whitespace (including tabs/newlines) to a single space", () => {
    expect(normalizeSearchQuery("acme\t\n  corp")).toEqual({ ok: true, value: "acme corp" });
  });
});

describe("normalizeSearchQuery — case", () => {
  it("preserves case (case-insensitivity is applied at match time, not normalization time)", () => {
    expect(normalizeSearchQuery("AcMe")).toEqual({ ok: true, value: "AcMe" });
  });
});

describe("normalizeSearchQuery — min/max length", () => {
  it(`rejects a query shorter than ${SEARCH_QUERY_MIN_LENGTH} characters`, () => {
    expect(normalizeSearchQuery("a")).toEqual({ ok: false, reason: "too_short" });
  });

  it("rejects an empty string", () => {
    expect(normalizeSearchQuery("")).toEqual({ ok: false, reason: "too_short" });
  });

  it("rejects a string that collapses to below the minimum after trimming", () => {
    expect(normalizeSearchQuery("  a  ")).toEqual({ ok: false, reason: "too_short" });
  });

  it(`accepts exactly ${SEARCH_QUERY_MIN_LENGTH} characters`, () => {
    const value = "a".repeat(SEARCH_QUERY_MIN_LENGTH);
    expect(normalizeSearchQuery(value)).toEqual({ ok: true, value });
  });

  it(`truncates a query longer than ${SEARCH_QUERY_MAX_LENGTH} characters rather than rejecting it`, () => {
    const long = "a".repeat(SEARCH_QUERY_MAX_LENGTH + 50);
    const result = normalizeSearchQuery(long);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe("a".repeat(SEARCH_QUERY_MAX_LENGTH));
  });

  it("truncates after collapsing whitespace, not before", () => {
    const long = "a ".repeat(SEARCH_QUERY_MAX_LENGTH); // collapses to far fewer real characters
    const result = normalizeSearchQuery(long);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.length).toBeLessThanOrEqual(SEARCH_QUERY_MAX_LENGTH);
  });
});

describe("normalizeSearchQuery — unicode", () => {
  it("accepts and preserves non-Latin scripts", () => {
    expect(normalizeSearchQuery("日本語 テスト")).toEqual({ ok: true, value: "日本語 テスト" });
  });

  it("NFC-normalizes combining-character sequences", () => {
    const decomposed = "café"; // "café" written as e + combining acute accent
    const composed = "café";
    const result = normalizeSearchQuery(decomposed);
    expect(result).toEqual({ ok: true, value: composed });
  });
});

describe("normalizeSearchQuery — never throws on malformed input", () => {
  it("treats non-string input as empty", () => {
    expect(normalizeSearchQuery(null)).toEqual({ ok: false, reason: "too_short" });
    expect(normalizeSearchQuery(undefined)).toEqual({ ok: false, reason: "too_short" });
    expect(normalizeSearchQuery(42)).toEqual({ ok: false, reason: "too_short" });
  });
});

describe("normalizeSearchQuery — control characters", () => {
  it("strips embedded control characters (including NUL) rather than passing them through to a downstream query", () => {
    // Built via String.fromCharCode, never typed as literal escape
    // notation in source (see this project's own established convention
    // for avoiding tool-transport corruption of control-character text).
    const withControls = "ac" + String.fromCharCode(0) + "me" + String.fromCharCode(1);
    expect(normalizeSearchQuery(withControls)).toEqual({ ok: true, value: "acme" });
  });

  it("a query that is entirely control characters normalizes to empty (too_short), not a crash", () => {
    const onlyControls = String.fromCharCode(0) + String.fromCharCode(1) + String.fromCharCode(2);
    expect(normalizeSearchQuery(onlyControls)).toEqual({ ok: false, reason: "too_short" });
  });
});

describe("escapeLikePattern", () => {
  it("escapes a literal percent sign", () => {
    expect(escapeLikePattern("50%")).toBe("50\\%");
  });

  it("escapes a literal underscore", () => {
    expect(escapeLikePattern("a_b")).toBe("a\\_b");
  });

  it("escapes a literal backslash", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });

  it("escapes backslash before it would double-escape a wildcard that follows it", () => {
    expect(escapeLikePattern("\\%")).toBe("\\\\\\%");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeLikePattern("Acme Corp")).toBe("Acme Corp");
  });
});
