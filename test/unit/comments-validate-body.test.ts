import { describe, expect, it } from "vitest";
import { validateCommentBody, COMMENT_BODY_MAX_LENGTH } from "@/lib/comments/validate-body";

describe("validateCommentBody — empty/whitespace", () => {
  it("rejects an empty string", () => {
    expect(validateCommentBody("")).toEqual({ ok: false, error: "empty" });
  });

  it("rejects a whitespace-only string", () => {
    expect(validateCommentBody("   \n\t  ")).toEqual({ ok: false, error: "empty" });
  });

  it("rejects non-string input", () => {
    expect(validateCommentBody(null)).toEqual({ ok: false, error: "empty" });
    expect(validateCommentBody(undefined)).toEqual({ ok: false, error: "empty" });
    expect(validateCommentBody(42)).toEqual({ ok: false, error: "empty" });
  });

  it("trims leading/trailing whitespace", () => {
    const result = validateCommentBody("  hello world  ");
    expect(result).toEqual({ ok: true, body: "hello world" });
  });
});

describe("validateCommentBody — max length boundary", () => {
  it("accepts a body exactly at the max length", () => {
    const body = "a".repeat(COMMENT_BODY_MAX_LENGTH);
    const result = validateCommentBody(body);
    expect(result.ok).toBe(true);
  });

  it("rejects a body one character above the max length", () => {
    const body = "a".repeat(COMMENT_BODY_MAX_LENGTH + 1);
    expect(validateCommentBody(body)).toEqual({ ok: false, error: "too_long" });
  });
});

describe("validateCommentBody — plain text only, never executed as markup", () => {
  it("a script-tag-shaped string is accepted as plain text, untouched", () => {
    const body = '<script>alert("x")</script>';
    const result = validateCommentBody(body);
    expect(result).toEqual({ ok: true, body });
  });

  it("markdown-shaped text is stored verbatim, never converted", () => {
    const body = "# Heading\n**bold** _italic_ [link](http://example.com)";
    const result = validateCommentBody(body);
    expect(result).toEqual({ ok: true, body });
  });
});

describe("validateCommentBody — control characters and line endings", () => {
  it("CRLF is normalized to a plain newline", () => {
    const result = validateCommentBody("line one\r\nline two");
    expect(result).toEqual({ ok: true, body: "line one\nline two" });
  });

  it("a lone CR is normalized to a plain newline", () => {
    const result = validateCommentBody("line one\rline two");
    expect(result).toEqual({ ok: true, body: "line one\nline two" });
  });

  it("an embedded NUL control character is stripped (Postgres text columns cannot store one)", () => {
    const withNul = "hello" + String.fromCharCode(0) + "world";
    const result = validateCommentBody(withNul);
    expect(result).toEqual({ ok: true, body: "helloworld" });
  });

  it("internal whitespace (not just leading/trailing) is preserved", () => {
    const result = validateCommentBody("hello   world\n\nwith blank lines");
    expect(result).toEqual({ ok: true, body: "hello   world\n\nwith blank lines" });
  });
});

describe("validateCommentBody — mention tokens are never cut out of the body", () => {
  it("a valid mention token survives validation byte for byte", () => {
    const uuid = "3f9e2b41-1234-4abc-9def-0123456789ab";
    const body = `Hey @[Jane Doe](user:${uuid}), please take a look.`;
    const result = validateCommentBody(body);
    expect(result).toEqual({ ok: true, body });
  });
});
