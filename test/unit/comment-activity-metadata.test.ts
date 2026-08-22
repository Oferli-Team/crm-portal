import { describe, expect, it } from "vitest";
import {
  buildCommentCreatedMetadata,
  buildCommentUpdatedMetadata,
  buildCommentDeletedMetadata,
} from "@/lib/activity/comment-metadata";
import { formatActivity } from "@/lib/activity/format-activity";
import { FIXED_NOW } from "../support/fixtures";

describe("comment-metadata builders — allowlisted shape only", () => {
  it("CREATED carries exactly the allowlisted fields", () => {
    const metadata = buildCommentCreatedMetadata({
      parentEntityType: "PROJECT",
      parentEntityLabel: "Website Redesign",
      actorName: "Jane Doe",
      commentPreview: "Looks good",
      mentionCount: 2,
    });
    expect(metadata).toEqual({
      parentEntityType: "PROJECT",
      parentEntityLabel: "Website Redesign",
      actorName: "Jane Doe",
      commentPreview: "Looks good",
      mentionCount: 2,
    });
  });

  it("UPDATED carries the allowlisted fields plus added/removed mention counts", () => {
    const metadata = buildCommentUpdatedMetadata({
      parentEntityType: "TASK",
      parentEntityLabel: "Fix login bug",
      actorName: "Jane Doe",
      commentPreview: "Updated with more detail",
      mentionCount: 1,
      addedMentionCount: 1,
      removedMentionCount: 0,
    });
    expect(metadata).toEqual({
      parentEntityType: "TASK",
      parentEntityLabel: "Fix login bug",
      actorName: "Jane Doe",
      commentPreview: "Updated with more detail",
      mentionCount: 1,
      addedMentionCount: 1,
      removedMentionCount: 0,
    });
  });

  it("DELETED carries actorName, authorName, and the moderated flag — never a body or id", () => {
    const metadata = buildCommentDeletedMetadata({
      parentEntityType: "PROJECT",
      parentEntityLabel: "Website Redesign",
      actorName: "Jane Doe (owner)",
      authorName: "John Smith",
      moderated: true,
    });
    expect(metadata).toEqual({
      parentEntityType: "PROJECT",
      parentEntityLabel: "Website Redesign",
      actorName: "Jane Doe (owner)",
      authorName: "John Smith",
      moderated: true,
    });
  });
});

describe("formatActivity — COMMENT events", () => {
  function activity(action: "CREATED" | "UPDATED" | "DELETED", metadata: unknown) {
    return formatActivity({ entityType: "COMMENT", action, metadata, actor: null, createdAt: FIXED_NOW });
  }

  it("CREATED on a project", () => {
    const result = activity("CREATED", {
      parentEntityType: "PROJECT",
      parentEntityLabel: "Website Redesign",
      actorName: "Jane Doe",
      commentPreview: "Looks good to me",
    });
    expect(result.actionLabel).toBe("commented on project Website Redesign");
    expect(result.entityLabel).toBe("Website Redesign");
    expect(result.detailLines).toEqual(["Looks good to me"]);
    expect(result.isDeleted).toBe(false);
  });

  it("CREATED on a task", () => {
    const result = activity("CREATED", {
      parentEntityType: "TASK",
      parentEntityLabel: "Fix login bug",
      actorName: "Jane Doe",
      commentPreview: "",
    });
    expect(result.actionLabel).toBe("commented on task Fix login bug");
    expect(result.detailLines).toEqual([]);
  });

  it("UPDATED on a task", () => {
    const result = activity("UPDATED", {
      parentEntityType: "TASK",
      parentEntityLabel: "Fix login bug",
      actorName: "Jane Doe",
      commentPreview: "Edited detail",
    });
    expect(result.actionLabel).toBe("updated a comment on task Fix login bug");
    expect(result.detailLines).toEqual(["Edited detail"]);
  });

  it("DELETED from a project (self-delete)", () => {
    const result = activity("DELETED", {
      parentEntityType: "PROJECT",
      parentEntityLabel: "Website Redesign",
      actorName: "Jane Doe",
      authorName: "Jane Doe",
      moderated: false,
    });
    expect(result.actionLabel).toBe("deleted a comment from project Website Redesign");
    expect(result.isDeleted).toBe(true);
  });

  it("DELETED — moderation case renders safely with the same phrasing, never crashes", () => {
    const result = activity("DELETED", {
      parentEntityType: "PROJECT",
      parentEntityLabel: "Website Redesign",
      actorName: "Jane Doe (owner)",
      authorName: "John Smith",
      moderated: true,
    });
    expect(result.actionLabel).toBe("deleted a comment from project Website Redesign");
    expect(result.isDeleted).toBe(true);
  });

  it("malformed metadata (missing parentEntityLabel) falls back to 'Activity recorded'", () => {
    const result = activity("CREATED", { parentEntityType: "PROJECT" });
    expect(result.actionLabel).toBe("Activity recorded");
    expect(result.entityLabel).toBeNull();
  });

  it("malformed metadata (unknown parentEntityType) falls back to 'Activity recorded'", () => {
    const result = activity("CREATED", { parentEntityType: "INVOICE", parentEntityLabel: "X" });
    expect(result.actionLabel).toBe("Activity recorded");
  });

  it("entirely empty metadata never throws and falls back safely", () => {
    expect(() => activity("CREATED", {})).not.toThrow();
    expect(activity("CREATED", {}).actionLabel).toBe("Activity recorded");
  });

  it("non-object metadata never throws and falls back safely", () => {
    expect(() => activity("CREATED", "not an object")).not.toThrow();
    expect(() => activity("CREATED", null)).not.toThrow();
  });
});
