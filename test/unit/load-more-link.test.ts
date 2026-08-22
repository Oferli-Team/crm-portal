import { describe, expect, it } from "vitest";
import { buildLoadMoreHref } from "@/components/activity/load-more-link";

describe("buildLoadMoreHref", () => {
  it("defaults to the 'cursor' param name", () => {
    expect(buildLoadMoreHref("/activity", {}, "abc123")).toBe("/activity?cursor=abc123");
  });

  it("preserves other already-active params alongside the cursor", () => {
    expect(buildLoadMoreHref("/notifications", { filter: "unread" }, "abc123")).toBe(
      "/notifications?filter=unread&cursor=abc123",
    );
  });

  it("uses a caller-supplied cursorParam name instead of 'cursor', so two independently-paginated lists on the same page never collide", () => {
    expect(buildLoadMoreHref("/projects/1/edit", {}, "xyz789", "commentsCursor")).toBe(
      "/projects/1/edit?commentsCursor=xyz789",
    );
  });

  it("never disturbs unrelated params when using a custom cursorParam", () => {
    const href = buildLoadMoreHref("/tasks/1/edit", { someOtherParam: "keep-me" }, "xyz789", "commentsCursor");
    expect(href).toBe("/tasks/1/edit?someOtherParam=keep-me&commentsCursor=xyz789");
  });

  it("overwrites a stale cursor value for the same param name rather than duplicating it", () => {
    const href = buildLoadMoreHref("/activity", { cursor: "old-value" }, "new-value");
    expect(href).toBe("/activity?cursor=new-value");
  });
});
