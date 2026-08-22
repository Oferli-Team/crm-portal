import { describe, expect, it } from "vitest";
import {
  buildClientResultUrl,
  buildProjectResultUrl,
  buildTaskResultUrl,
  buildInvoiceResultUrl,
  buildCommentResultUrl,
  buildResultUrl,
} from "@/lib/search/result-links";

const VALID_UUID = "3f9e2b41-1234-4abc-9def-0123456789ab";
const VALID_UUID_2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("per-type link builders — all 5 types", () => {
  it("Client", () => {
    expect(buildClientResultUrl(VALID_UUID)).toBe(`/clients/${VALID_UUID}/edit`);
  });

  it("Project", () => {
    expect(buildProjectResultUrl(VALID_UUID)).toBe(`/projects/${VALID_UUID}/edit`);
  });

  it("Task", () => {
    expect(buildTaskResultUrl(VALID_UUID)).toBe(`/tasks/${VALID_UUID}/edit`);
  });

  it("Invoice", () => {
    expect(buildInvoiceResultUrl(VALID_UUID)).toBe(`/invoices/${VALID_UUID}/edit`);
  });

  it("Comment under a Project", () => {
    expect(buildCommentResultUrl("PROJECT", VALID_UUID, VALID_UUID_2)).toBe(
      `/projects/${VALID_UUID}/edit#comment-${VALID_UUID_2}`,
    );
  });

  it("Comment under a Task", () => {
    expect(buildCommentResultUrl("TASK", VALID_UUID, VALID_UUID_2)).toBe(
      `/tasks/${VALID_UUID}/edit#comment-${VALID_UUID_2}`,
    );
  });
});

describe("link builders — invalid input never produces a URL", () => {
  it("an invalid UUID for a Client id returns null", () => {
    expect(buildClientResultUrl("not-a-uuid")).toBeNull();
  });

  it("an invalid UUID for a Project id returns null", () => {
    expect(buildProjectResultUrl("../../etc/passwd")).toBeNull();
  });

  it("an unrecognized Comment parent type returns null", () => {
    expect(buildCommentResultUrl("INVOICE", VALID_UUID, VALID_UUID_2)).toBeNull();
  });

  it("an invalid parent id for a Comment returns null", () => {
    expect(buildCommentResultUrl("PROJECT", "<script>alert(1)</script>", VALID_UUID_2)).toBeNull();
  });

  it("an invalid comment id returns null", () => {
    expect(buildCommentResultUrl("PROJECT", VALID_UUID, "not-a-uuid")).toBeNull();
  });

  it("never builds a URL by string-concatenating unchecked input — a hostile parentId never survives into the returned path", () => {
    const result = buildCommentResultUrl("PROJECT", "https://evil.example.com", VALID_UUID_2);
    expect(result).toBeNull();
  });
});

describe("buildResultUrl — dispatcher", () => {
  it("dispatches to each per-type builder correctly", () => {
    expect(buildResultUrl("CLIENT", VALID_UUID)).toBe(`/clients/${VALID_UUID}/edit`);
    expect(buildResultUrl("PROJECT", VALID_UUID)).toBe(`/projects/${VALID_UUID}/edit`);
    expect(buildResultUrl("TASK", VALID_UUID)).toBe(`/tasks/${VALID_UUID}/edit`);
    expect(buildResultUrl("INVOICE", VALID_UUID)).toBe(`/invoices/${VALID_UUID}/edit`);
  });

  it("dispatches a Comment result given its parent context", () => {
    expect(buildResultUrl("COMMENT", VALID_UUID_2, { parentType: "TASK", parentId: VALID_UUID })).toBe(
      `/tasks/${VALID_UUID}/edit#comment-${VALID_UUID_2}`,
    );
  });

  it("returns null for a Comment with no parent context supplied", () => {
    expect(buildResultUrl("COMMENT", VALID_UUID_2)).toBeNull();
  });

  it("returns null for an unrecognized type", () => {
    // @ts-expect-error deliberately invalid type, to prove the dispatcher degrades safely rather than throwing
    expect(buildResultUrl("NOT_A_TYPE", VALID_UUID)).toBeNull();
  });
});
