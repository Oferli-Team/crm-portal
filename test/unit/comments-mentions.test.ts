import { describe, expect, it } from "vitest";
import { parseMentionTokens, buildMentionToken, MAX_MENTIONS_PER_COMMENT } from "@/lib/comments/mentions";

const UUID_A = "3f9e2b41-1234-4abc-9def-0123456789ab";
const UUID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("parseMentionTokens — valid tokens", () => {
  it("parses a single well-formed token", () => {
    const result = parseMentionTokens(`Hey @[Jane Doe](user:${UUID_A}), can you review this?`);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0]).toEqual({
      userId: UUID_A.toLowerCase(),
      displayName: "Jane Doe",
      raw: `@[Jane Doe](user:${UUID_A})`,
      start: 4,
      end: 4 + `@[Jane Doe](user:${UUID_A})`.length,
    });
    expect(result.uniqueUserIds).toEqual([UUID_A.toLowerCase()]);
  });

  it("parses multiple distinct tokens in text order", () => {
    const result = parseMentionTokens(
      `@[Jane Doe](user:${UUID_A}) and @[John Smith](user:${UUID_B}), please look.`,
    );
    expect(result.mentions.map((m) => m.displayName)).toEqual(["Jane Doe", "John Smith"]);
    expect(result.uniqueUserIds).toEqual([UUID_A.toLowerCase(), UUID_B.toLowerCase()]);
  });

  it("uppercase uuid segments are normalized to lowercase for the dedupe key", () => {
    const result = parseMentionTokens(`@[Jane Doe](user:${UUID_A.toUpperCase()})`);
    expect(result.uniqueUserIds).toEqual([UUID_A.toLowerCase()]);
  });
});

describe("parseMentionTokens — duplicates", () => {
  it("the same userId mentioned twice appears twice in mentions[] but once in uniqueUserIds", () => {
    const result = parseMentionTokens(
      `Thanks @[Jane Doe](user:${UUID_A}) — following up, @[Jane Doe](user:${UUID_A}) any update?`,
    );
    expect(result.mentions).toHaveLength(2);
    expect(result.uniqueUserIds).toEqual([UUID_A.toLowerCase()]);
  });
});

describe("parseMentionTokens — malformed input never produces a mention", () => {
  it("a malformed uuid (wrong shape) is left as plain text", () => {
    const result = parseMentionTokens("@[Someone](user:not-a-uuid)");
    expect(result.mentions).toHaveLength(0);
    expect(result.uniqueUserIds).toHaveLength(0);
  });

  it("a uuid with the wrong number of hex digits does not match", () => {
    const result = parseMentionTokens("@[Someone](user:3f9e2b41-1234-4abc-9def-0123456789)");
    expect(result.mentions).toHaveLength(0);
  });

  it("broken brackets (missing closing bracket) do not match", () => {
    const result = parseMentionTokens(`@[Jane Doe(user:${UUID_A})`);
    expect(result.mentions).toHaveLength(0);
  });

  it("broken parens (missing closing paren) do not match", () => {
    const result = parseMentionTokens(`@[Jane Doe](user:${UUID_A}`);
    expect(result.mentions).toHaveLength(0);
  });

  it("free-text @name is never parsed as a mention", () => {
    const result = parseMentionTokens("Hey @jane, can you take a look?");
    expect(result.mentions).toHaveLength(0);
    expect(result.uniqueUserIds).toHaveLength(0);
  });

  it("a missing 'user:' prefix does not match", () => {
    const result = parseMentionTokens(`@[Jane Doe](${UUID_A})`);
    expect(result.mentions).toHaveLength(0);
  });
});

describe("parseMentionTokens — unicode and edge-case display names", () => {
  it("a unicode display name is preserved as-is", () => {
    const result = parseMentionTokens(`@[日本語 Ñoño](user:${UUID_A})`);
    expect(result.mentions[0]?.displayName).toBe("日本語 Ñoño");
    expect(result.uniqueUserIds).toEqual([UUID_A.toLowerCase()]);
  });

  it("a display name containing a literal ']' before the real closing bracket breaks the whole token — no mention, safely left as text", () => {
    // The display name capture group is [^\]\n]{1,100} — it stops at the
    // first `]` it sees, so "Jane [Doe]](user:...)" tries to close after
    // "Jane [Doe", then requires a literal "(" next; the actual next
    // character is the second "]", so the match fails entirely rather
    // than producing a mention with a truncated/wrong display name.
    const result = parseMentionTokens(`@[Jane [Doe]](user:${UUID_A})`);
    expect(result.mentions).toHaveLength(0);
    expect(result.uniqueUserIds).toHaveLength(0);
  });

  it("a token embedded inside other punctuation still parses", () => {
    const result = parseMentionTokens(`(cc: @[Jane Doe](user:${UUID_A}).)`);
    expect(result.mentions).toHaveLength(1);
  });
});

describe("parseMentionTokens — control characters and structural safety", () => {
  it("control characters elsewhere in the body do not prevent a valid token from parsing", () => {
    const result = parseMentionTokens(`line one\x01\x02 @[Jane Doe](user:${UUID_A})`);
    expect(result.mentions).toHaveLength(1);
  });

  it("a display name cannot span a newline", () => {
    const result = parseMentionTokens("@[Jane\nDoe](user:" + UUID_A + ")");
    expect(result.mentions).toHaveLength(0);
  });

  it("never throws on non-string input", () => {
    // parseMentionTokens is typed to accept `unknown` specifically so
    // runtime-only bad input (not just a TypeScript-caught mistake) is
    // still handled defensively — no @ts-expect-error needed here.
    expect(() => parseMentionTokens(null)).not.toThrow();
    expect(() => parseMentionTokens(undefined)).not.toThrow();
    expect(parseMentionTokens(42)).toEqual({ mentions: [], uniqueUserIds: [] });
  });

  it("empty string produces an empty result", () => {
    expect(parseMentionTokens("")).toEqual({ mentions: [], uniqueUserIds: [] });
  });
});

describe("parseMentionTokens — max mention count", () => {
  function buildBodyWithNMentions(n: number): string {
    return Array.from({ length: n }, (_, i) => {
      const uuid = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      return `@[User ${i}](user:${uuid})`;
    }).join(" ");
  }

  it("accepts exactly MAX_MENTIONS_PER_COMMENT distinct users", () => {
    const result = parseMentionTokens(buildBodyWithNMentions(MAX_MENTIONS_PER_COMMENT));
    expect(result.uniqueUserIds).toHaveLength(MAX_MENTIONS_PER_COMMENT);
    expect(result.mentions).toHaveLength(MAX_MENTIONS_PER_COMMENT);
  });

  it("caps at MAX_MENTIONS_PER_COMMENT when more distinct users are mentioned — the excess is dropped entirely, not just from uniqueUserIds", () => {
    const result = parseMentionTokens(buildBodyWithNMentions(MAX_MENTIONS_PER_COMMENT + 5));
    expect(result.uniqueUserIds).toHaveLength(MAX_MENTIONS_PER_COMMENT);
    expect(result.mentions).toHaveLength(MAX_MENTIONS_PER_COMMENT);
  });

  it("a repeat mention of an already-counted user past the cap point is still recorded in mentions[]", () => {
    const atCap = buildBodyWithNMentions(MAX_MENTIONS_PER_COMMENT);
    const firstUuid = "00000000-0000-4000-8000-000000000000";
    const body = `${atCap} thanks again @[User 0](user:${firstUuid})`;
    const result = parseMentionTokens(body);
    expect(result.uniqueUserIds).toHaveLength(MAX_MENTIONS_PER_COMMENT);
    expect(result.mentions).toHaveLength(MAX_MENTIONS_PER_COMMENT + 1);
  });
});

describe("parseMentionTokens — no catastrophic behavior on long/adversarial input", () => {
  it("completes quickly on a long body with many '@[' openers and no closing tokens", () => {
    const adversarial = "@[".repeat(20_000) + "not a real token";
    const start = performance.now();
    const result = parseMentionTokens(adversarial);
    const elapsedMs = performance.now() - start;
    expect(result.mentions).toHaveLength(0);
    expect(elapsedMs).toBeLessThan(500);
  });

  it("completes quickly on a very long plain-text body with no tokens at all", () => {
    const longBody = "x".repeat(500_000);
    const start = performance.now();
    const result = parseMentionTokens(longBody);
    const elapsedMs = performance.now() - start;
    expect(result.mentions).toHaveLength(0);
    expect(elapsedMs).toBeLessThan(500);
  });

  it("completes quickly on many back-to-back valid tokens", () => {
    const body = buildManyValidTokens(5000);
    const start = performance.now();
    const result = parseMentionTokens(body);
    const elapsedMs = performance.now() - start;
    expect(result.mentions.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(1000);
  });

  function buildManyValidTokens(n: number): string {
    let out = "";
    for (let i = 0; i < n; i++) {
      const hex = i.toString(16).padStart(8, "0");
      out += `@[U${i}](user:${hex}-0000-4000-8000-000000000000) `;
    }
    return out;
  }
});

describe("buildMentionToken — the composer's own token constructor", () => {
  const UUID_A = "3f9e2b41-1234-4abc-9def-0123456789ab";

  it("builds a token that the parser recognizes, round-trip", () => {
    const token = buildMentionToken("Jane Doe", UUID_A);
    expect(token).toBe(`@[Jane Doe](user:${UUID_A})`);
    const parsed = parseMentionTokens(token);
    expect(parsed.mentions).toEqual([
      { userId: UUID_A, displayName: "Jane Doe", raw: token, start: 0, end: token.length },
    ]);
  });

  it("strips a literal ']' from the display name so the token still parses", () => {
    const token = buildMentionToken("Jane [Doe]", UUID_A);
    expect(token).not.toContain("]Doe]");
    const parsed = parseMentionTokens(token);
    expect(parsed.mentions).toHaveLength(1);
    expect(parsed.mentions[0].userId).toBe(UUID_A);
  });

  it("strips newlines from the display name so the token still parses", () => {
    const token = buildMentionToken("Jane\nDoe", UUID_A);
    const parsed = parseMentionTokens(token);
    expect(parsed.mentions).toHaveLength(1);
  });

  it("truncates a very long display name to the parser's own 100-char cap", () => {
    const longName = "x".repeat(500);
    const token = buildMentionToken(longName, UUID_A);
    const parsed = parseMentionTokens(token);
    expect(parsed.mentions).toHaveLength(1);
    expect(parsed.mentions[0].displayName.length).toBeLessThanOrEqual(100);
  });

  it("falls back to a safe generic name if the display name is empty or only unsafe characters", () => {
    expect(buildMentionToken("", UUID_A)).toBe(`@[User](user:${UUID_A})`);
    expect(buildMentionToken("]\n", UUID_A)).toBe(`@[User](user:${UUID_A})`);
  });

  it("trims surrounding whitespace from the display name", () => {
    expect(buildMentionToken("  Jane Doe  ", UUID_A)).toBe(`@[Jane Doe](user:${UUID_A})`);
  });
});
