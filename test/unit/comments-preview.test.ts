import { describe, expect, it } from "vitest";
import { buildCommentPreview, COMMENT_PREVIEW_MAX_LENGTH } from "@/lib/comments/preview";

describe("buildCommentPreview — truncation", () => {
  it("returns short text unchanged", () => {
    expect(buildCommentPreview("Looks good to me!")).toBe("Looks good to me!");
  });

  it("truncates text longer than the max length and appends an ellipsis", () => {
    const long = "a".repeat(COMMENT_PREVIEW_MAX_LENGTH + 50);
    const preview = buildCommentPreview(long);
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(COMMENT_PREVIEW_MAX_LENGTH + 1);
  });

  it("does not append an ellipsis when no truncation happened", () => {
    const exact = "a".repeat(COMMENT_PREVIEW_MAX_LENGTH);
    expect(buildCommentPreview(exact)).toBe(exact);
  });

  it("respects a custom maxLength argument", () => {
    expect(buildCommentPreview("hello world", 5)).toBe("hello…");
  });
});

describe("buildCommentPreview — whitespace collapse", () => {
  it("collapses newlines and repeated whitespace into single spaces", () => {
    expect(buildCommentPreview("line one\n\nline two\t\ttabbed")).toBe("line one line two tabbed");
  });

  it("trims leading/trailing whitespace", () => {
    expect(buildCommentPreview("   padded text   ")).toBe("padded text");
  });

  it("collapses control characters along with whitespace", () => {
    expect(buildCommentPreview("hello\x01\x02world")).toBe("hello world");
  });
});

describe("buildCommentPreview — no raw token/ID leakage", () => {
  it("strips the raw mention token syntax, keeping only the display name", () => {
    const uuid = "3f9e2b41-1234-4abc-9def-0123456789ab";
    const preview = buildCommentPreview(`Hey @[Jane Doe](user:${uuid}), thanks!`);
    expect(preview).toBe("Hey @Jane Doe, thanks!");
    expect(preview).not.toContain(uuid);
    expect(preview).not.toContain("(user:");
  });

  it("strips multiple mention tokens", () => {
    const uuidA = "3f9e2b41-1234-4abc-9def-0123456789ab";
    const uuidB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const preview = buildCommentPreview(`@[Jane](user:${uuidA}) and @[John](user:${uuidB})`);
    expect(preview).toBe("@Jane and @John");
  });
});

describe("buildCommentPreview — determinism and safety", () => {
  it("is deterministic for the same input", () => {
    const body = "Some comment text with\nnewlines and   spaces";
    expect(buildCommentPreview(body)).toBe(buildCommentPreview(body));
  });

  it("never throws on non-string input", () => {
    expect(buildCommentPreview(null)).toBe("");
    expect(buildCommentPreview(undefined)).toBe("");
    expect(buildCommentPreview(42)).toBe("");
  });

  it("never returns raw HTML for script-like input", () => {
    const preview = buildCommentPreview('<script>alert("x")</script>');
    expect(preview).toBe('<script>alert("x")</script>');
  });
});
