import { describe, expect, it } from "vitest";
import { splitBodyIntoSegments, formatCommentViewModel, resolveCommentPermissions } from "@/lib/comments/format-comment";
import { FIXED_NOW } from "../support/fixtures";

const UUID_A = "3f9e2b41-1234-4abc-9def-0123456789ab";
const UUID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("splitBodyIntoSegments", () => {
  it("a body with no mention tokens is a single text segment", () => {
    expect(splitBodyIntoSegments("hello world", new Set())).toEqual([{ type: "text", value: "hello world" }]);
  });

  it("an empty body produces no segments", () => {
    expect(splitBodyIntoSegments("", new Set())).toEqual([]);
  });

  it("a valid, persisted mention becomes a mention segment", () => {
    const body = `Hey @[Jane Doe](user:${UUID_A}), please look.`;
    const segments = splitBodyIntoSegments(body, new Set([UUID_A]));
    expect(segments).toEqual([
      { type: "text", value: "Hey " },
      { type: "mention", userId: UUID_A, displayName: "Jane Doe" },
      { type: "text", value: ", please look." },
    ]);
  });

  it("a well-formed token whose userId has no matching persisted Mention renders as plain text", () => {
    const body = `Hey @[Jane Doe](user:${UUID_A}), please look.`;
    const segments = splitBodyIntoSegments(body, new Set());
    expect(segments).toEqual([{ type: "text", value: body }]);
  });

  it("a malformed token (never matched by the parser at all) is plain text, byte for byte", () => {
    const body = "Hey @[Jane Doe](user:not-a-uuid), please look.";
    const segments = splitBodyIntoSegments(body, new Set([UUID_A]));
    expect(segments).toEqual([{ type: "text", value: body }]);
  });

  it("multiple valid mentions interleaved with text produce segments in order", () => {
    const body = `@[Jane](user:${UUID_A}) and @[John](user:${UUID_B}) both, thanks`;
    const segments = splitBodyIntoSegments(body, new Set([UUID_A, UUID_B]));
    expect(segments).toEqual([
      { type: "mention", userId: UUID_A, displayName: "Jane" },
      { type: "text", value: " and " },
      { type: "mention", userId: UUID_B, displayName: "John" },
      { type: "text", value: " both, thanks" },
    ]);
  });

  it("mixed valid and invalid mentions in one body — only the valid one becomes a segment, the other stays merged as text", () => {
    const body = `@[Jane](user:${UUID_A}) and @[John](user:${UUID_B})`;
    const segments = splitBodyIntoSegments(body, new Set([UUID_A]));
    expect(segments).toEqual([
      { type: "mention", userId: UUID_A, displayName: "Jane" },
      { type: "text", value: ` and @[John](user:${UUID_B})` },
    ]);
  });

  it("never throws on adversarial input", () => {
    expect(() => splitBodyIntoSegments("@[".repeat(10_000), new Set())).not.toThrow();
  });
});

describe("formatCommentViewModel", () => {
  const baseInput = {
    id: "comment-1",
    authorId: "user-1",
    author: { name: "Jane Doe" },
    body: "hello world",
    editedAt: null,
    deletedAt: null,
    createdAt: FIXED_NOW,
    mentions: [],
  };

  it("a normal, unedited, non-deleted comment", () => {
    const result = formatCommentViewModel(baseInput);
    expect(result.authorName).toBe("Jane Doe");
    expect(result.isEdited).toBe(false);
    expect(result.isDeleted).toBe(false);
    expect(result.segments).toEqual([{ type: "text", value: "hello world" }]);
    expect(result.placeholder).toBeNull();
  });

  it("an edited comment sets isEdited", () => {
    const result = formatCommentViewModel({ ...baseInput, editedAt: FIXED_NOW });
    expect(result.isEdited).toBe(true);
  });

  it("a deleted comment never renders its body — only the placeholder, with empty segments", () => {
    const result = formatCommentViewModel({ ...baseInput, deletedAt: FIXED_NOW, body: "something regrettable" });
    expect(result.isDeleted).toBe(true);
    expect(result.segments).toEqual([]);
    expect(result.placeholder).toBe("This comment was deleted.");
  });

  it("an author whose User row is gone (authorId null, author null) falls back to a neutral label", () => {
    const result = formatCommentViewModel({ ...baseInput, authorId: null, author: null });
    expect(result.authorName).toBe("Deleted user");
  });

  it("renders a valid mention as a segment, using only currently-persisted CommentMention rows", () => {
    const body = `Hey @[Jane Doe](user:${UUID_A})`;
    const result = formatCommentViewModel({ ...baseInput, body, mentions: [{ userId: UUID_A }] });
    expect(result.segments).toEqual([
      { type: "text", value: "Hey " },
      { type: "mention", userId: UUID_A, displayName: "Jane Doe" },
    ]);
  });

  it("never throws on malformed body content", () => {
    expect(() => formatCommentViewModel({ ...baseInput, body: "@[".repeat(5000) })).not.toThrow();
  });

  it("rawBody carries the exact stored body, mention tokens intact, for a non-deleted comment", () => {
    const body = `Hey @[Jane Doe](user:${UUID_A})`;
    const result = formatCommentViewModel({ ...baseInput, body, mentions: [{ userId: UUID_A }] });
    expect(result.rawBody).toBe(body);
  });

  it("rawBody is null for a deleted comment — its body is never exposed at all", () => {
    const result = formatCommentViewModel({ ...baseInput, deletedAt: FIXED_NOW, body: "something regrettable" });
    expect(result.rawBody).toBeNull();
  });
});

describe("resolveCommentPermissions", () => {
  const authorComment = { authorId: "user-1", isDeleted: false };

  it("the author can edit and delete their own comment, regardless of role", () => {
    expect(resolveCommentPermissions(authorComment, "user-1", false)).toEqual({ canEdit: true, canDelete: true });
    expect(resolveCommentPermissions(authorComment, "user-1", true)).toEqual({ canEdit: true, canDelete: true });
  });

  it("a plain MEMBER (non-author, non-moderator) can neither edit nor delete someone else's comment", () => {
    expect(resolveCommentPermissions(authorComment, "user-2", false)).toEqual({ canEdit: false, canDelete: false });
  });

  it("OWNER/ADMIN (isModerator=true) can delete but never edit someone else's comment", () => {
    expect(resolveCommentPermissions(authorComment, "user-2", true)).toEqual({ canEdit: false, canDelete: true });
  });

  it("a deleted comment grants neither permission, even to its own author or a moderator", () => {
    const deletedComment = { authorId: "user-1", isDeleted: true };
    expect(resolveCommentPermissions(deletedComment, "user-1", false)).toEqual({ canEdit: false, canDelete: false });
    expect(resolveCommentPermissions(deletedComment, "user-2", true)).toEqual({ canEdit: false, canDelete: false });
  });

  it("an authorless (author-deleted) comment can still be moderation-deleted but never edited by anyone", () => {
    const authorlessComment = { authorId: null, isDeleted: false };
    expect(resolveCommentPermissions(authorlessComment, "user-2", true)).toEqual({ canEdit: false, canDelete: true });
    expect(resolveCommentPermissions(authorlessComment, "user-2", false)).toEqual({ canEdit: false, canDelete: false });
  });
});
