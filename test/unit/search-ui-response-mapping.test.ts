import { describe, expect, it } from "vitest";
import {
  buildSearchOutcome,
  SEARCH_UNAUTHORIZED_MESSAGE,
  SEARCH_GENERIC_ERROR_MESSAGE,
} from "@/lib/search-ui/response-mapping";

describe("buildSearchOutcome — success (200), valid responses", () => {
  it("passes an empty groups array through unmodified — the real 'query too short' shape", () => {
    const groups: unknown[] = [];
    expect(buildSearchOutcome(200, { query: "", groups })).toEqual({ kind: "success", groups: [] });
  });

  it("passes a fully-populated, well-formed item through with every field intact", () => {
    const groups = [
      {
        type: "CLIENT",
        items: [
          {
            type: "CLIENT",
            id: "11111111-1111-1111-1111-111111111111",
            title: "Acme Inc",
            subtitle: "acme@example.com",
            preview: null,
            url: "/clients/11111111-1111-1111-1111-111111111111/edit",
          },
        ],
      },
      { type: "PROJECT", items: [] },
      { type: "TASK", items: [] },
      { type: "INVOICE", items: [] },
      { type: "COMMENT", items: [] },
    ];
    expect(buildSearchOutcome(200, { query: "acme", groups })).toEqual({ kind: "success", groups });
  });

  it("treats a missing subtitle/preview key the same as an explicit null", () => {
    const groups = [
      {
        type: "TASK",
        items: [{ type: "TASK", id: "t1", title: "Task one", url: "/tasks/t1/edit" }],
      },
    ];
    const outcome = buildSearchOutcome(200, { groups });
    expect(outcome).toEqual({
      kind: "success",
      groups: [{ type: "TASK", items: [{ type: "TASK", id: "t1", title: "Task one", subtitle: null, preview: null, url: "/tasks/t1/edit" }] }],
    });
  });

  it("preserves group and item order — sanitization only ever filters, never reorders", () => {
    const groups = [
      { type: "CLIENT", items: [{ type: "CLIENT", id: "c1", title: "A", url: "/clients/c1/edit" }, { type: "CLIENT", id: "c2", title: "B", url: "/clients/c2/edit" }] },
      { type: "PROJECT", items: [] },
      { type: "TASK", items: [{ type: "TASK", id: "t1", title: "T", url: "/tasks/t1/edit" }] },
      { type: "INVOICE", items: [] },
      { type: "COMMENT", items: [] },
    ];
    const outcome = buildSearchOutcome(200, { groups });
    expect(outcome.kind === "success" && outcome.groups.map((g) => g.type)).toEqual([
      "CLIENT",
      "PROJECT",
      "TASK",
      "INVOICE",
      "COMMENT",
    ]);
    expect(outcome.kind === "success" && outcome.groups[0].items.map((i) => i.id)).toEqual(["c1", "c2"]);
  });
});

describe("buildSearchOutcome — success (200), defensive validation of malformed groups/items", () => {
  it("drops a group with an invalid/unknown type, keeping the other valid groups", () => {
    const groups = [
      { type: "NOT_A_REAL_TYPE", items: [] },
      { type: "CLIENT", items: [{ type: "CLIENT", id: "c1", title: "A", url: "/clients/c1/edit" }] },
    ];
    const outcome = buildSearchOutcome(200, { groups });
    expect(outcome.kind === "success" && outcome.groups.map((g) => g.type)).toEqual(["CLIENT"]);
  });

  it("drops a group whose items field is not an array", () => {
    const groups = [
      { type: "CLIENT", items: "not-an-array" },
      { type: "PROJECT", items: [] },
    ];
    const outcome = buildSearchOutcome(200, { groups });
    expect(outcome.kind === "success" && outcome.groups.map((g) => g.type)).toEqual(["PROJECT"]);
  });

  it("drops individual items missing a required string field (id/title/url/type), keeping valid siblings", () => {
    const groups = [
      {
        type: "CLIENT",
        items: [
          { type: "CLIENT", title: "Missing id", url: "/clients/x/edit" },
          { id: "c2", title: "Missing type", url: "/clients/c2/edit" },
          { type: "CLIENT", id: "c3", url: "/clients/c3/edit" }, // missing title
          { type: "CLIENT", id: "c4", title: "Missing url" },
          { type: "CLIENT", id: "c5", title: "Valid one", url: "/clients/c5/edit" },
        ],
      },
    ];
    const outcome = buildSearchOutcome(200, { groups });
    expect(outcome.kind === "success" && outcome.groups[0].items.map((i) => i.id)).toEqual(["c5"]);
  });

  it("drops an item whose optional subtitle/preview field is present but the wrong type", () => {
    const groups = [
      {
        type: "CLIENT",
        items: [
          { type: "CLIENT", id: "bad-subtitle", title: "A", url: "/x", subtitle: 123 },
          { type: "CLIENT", id: "bad-preview", title: "B", url: "/x", preview: { nested: true } },
          { type: "CLIENT", id: "ok", title: "C", url: "/x", subtitle: null, preview: "fine" },
        ],
      },
    ];
    const outcome = buildSearchOutcome(200, { groups });
    expect(outcome.kind === "success" && outcome.groups[0].items.map((i) => i.id)).toEqual(["ok"]);
  });

  it("silently strips unknown/internal fields instead of leaking them through", () => {
    const groups = [
      {
        type: "CLIENT",
        items: [
          {
            type: "CLIENT",
            id: "c1",
            title: "A",
            url: "/clients/c1/edit",
            organizationId: "should-never-appear",
            authorId: "should-never-appear-either",
          },
        ],
      },
    ];
    const outcome = buildSearchOutcome(200, { groups });
    const item = outcome.kind === "success" ? outcome.groups[0].items[0] : undefined;
    expect(item).toEqual({ type: "CLIENT", id: "c1", title: "A", subtitle: null, preview: null, url: "/clients/c1/edit" });
    expect(JSON.stringify(outcome)).not.toContain("should-never-appear");
  });

  it("escalates to a generic error when every group in a non-empty array is malformed (not silently 'no results')", () => {
    const groups = [
      { type: "NOT_REAL", items: [] },
      { type: "ALSO_NOT_REAL", items: "nope" },
    ];
    expect(buildSearchOutcome(200, { groups })).toEqual({ kind: "error" });
  });
});

describe("buildSearchOutcome — success (200), malformed top-level body escalates to a generic error", () => {
  it("a null body", () => {
    expect(buildSearchOutcome(200, null)).toEqual({ kind: "error" });
  });

  it("a body with no groups key at all", () => {
    expect(buildSearchOutcome(200, {})).toEqual({ kind: "error" });
  });

  it("a groups field that isn't an array", () => {
    expect(buildSearchOutcome(200, { groups: "not-an-array" })).toEqual({ kind: "error" });
    expect(buildSearchOutcome(200, { groups: { CLIENT: [] } })).toEqual({ kind: "error" });
    expect(buildSearchOutcome(200, { groups: null })).toEqual({ kind: "error" });
  });

  it("a body that is not an object at all", () => {
    expect(buildSearchOutcome(200, "just a string")).toEqual({ kind: "error" });
    expect(buildSearchOutcome(200, 42)).toEqual({ kind: "error" });
    expect(buildSearchOutcome(200, undefined)).toEqual({ kind: "error" });
    expect(buildSearchOutcome(200, [])).toEqual({ kind: "error" });
  });

  it("never throws, for a battery of deeply malformed 200 bodies", () => {
    const garbage: unknown[] = [
      null,
      undefined,
      "string",
      42,
      true,
      [],
      {},
      { groups: null },
      { groups: 42 },
      { groups: [null, undefined, 42, "x", [], true] },
      { groups: [{}] },
      { groups: [{ type: "CLIENT" }] },
      { groups: [{ type: "CLIENT", items: null }] },
      { groups: [{ type: "CLIENT", items: [null, undefined, 42, "x", [], true, {}] }] },
    ];
    for (const body of garbage) {
      expect(() => buildSearchOutcome(200, body)).not.toThrow();
    }
  });
});

describe("buildSearchOutcome — 401/403 mapping", () => {
  it("maps 401 to unauthorized", () => {
    expect(buildSearchOutcome(401, { error: "Not authenticated." })).toEqual({ kind: "unauthorized" });
  });

  it("maps 403 to unauthorized", () => {
    expect(buildSearchOutcome(403, { error: "Not authorized." })).toEqual({ kind: "unauthorized" });
  });

  it("never surfaces the raw backend auth message", () => {
    const outcome = buildSearchOutcome(401, { error: "Not authenticated." });
    expect(JSON.stringify(outcome)).not.toContain("Not authenticated");
    expect(SEARCH_UNAUTHORIZED_MESSAGE).not.toContain("authenticated");
  });
});

describe("buildSearchOutcome — 429 mapping", () => {
  it("passes through the backend's own rate-limit message", () => {
    expect(buildSearchOutcome(429, { error: "Too many requests. Please try again later." })).toEqual({
      kind: "rate_limited",
      message: "Too many requests. Please try again later.",
    });
  });

  it("falls back to a generic rate-limit message if the body is malformed", () => {
    const outcome = buildSearchOutcome(429, null);
    expect(outcome.kind).toBe("rate_limited");
    expect(outcome.kind === "rate_limited" && outcome.message.length > 0).toBe(true);
  });
});

describe("buildSearchOutcome — 500 and unrecognized statuses", () => {
  it("maps 500 to a generic error", () => {
    expect(buildSearchOutcome(500, { error: "Internal server error, stack trace, etc." })).toEqual({ kind: "error" });
  });

  it("never surfaces the raw backend error body for a 500", () => {
    const outcome = buildSearchOutcome(500, { error: "raw prisma stack trace" });
    expect(JSON.stringify(outcome)).not.toContain("prisma");
    expect(SEARCH_GENERIC_ERROR_MESSAGE).not.toContain("prisma");
  });

  it("maps any other unexpected status to a generic error rather than throwing", () => {
    expect(buildSearchOutcome(418, {})).toEqual({ kind: "error" });
    expect(buildSearchOutcome(0, undefined)).toEqual({ kind: "error" });
  });
});

describe("buildSearchOutcome — stable response shape", () => {
  it("a well-formed successful response is deep-equal to its input (rebuilt from known fields, not identical by reference — see sanitizeSearchResult)", () => {
    const groups = [{ type: "PROJECT" as const, items: [] }];
    const outcome = buildSearchOutcome(200, { groups });
    expect(outcome).toEqual({ kind: "success", groups });
  });
});
