import { describe, expect, it } from "vitest";
import { parseTimeRangeParam, DEFAULT_TIME_RANGE } from "@/lib/analytics/constants";

describe("parseTimeRangeParam", () => {
  it("accepts every real TimeRange value", () => {
    expect(parseTimeRangeParam("today")).toBe("today");
    expect(parseTimeRangeParam("last7Days")).toBe("last7Days");
    expect(parseTimeRangeParam("last30Days")).toBe("last30Days");
    expect(parseTimeRangeParam("last90Days")).toBe("last90Days");
    expect(parseTimeRangeParam("allTime")).toBe("allTime");
  });

  it("falls back to DEFAULT_TIME_RANGE for undefined", () => {
    expect(parseTimeRangeParam(undefined)).toBe(DEFAULT_TIME_RANGE);
  });

  it("falls back to DEFAULT_TIME_RANGE for an unrecognized string, never throwing", () => {
    expect(parseTimeRangeParam("last365Days")).toBe(DEFAULT_TIME_RANGE);
    expect(parseTimeRangeParam("")).toBe(DEFAULT_TIME_RANGE);
    expect(parseTimeRangeParam("'; DROP TABLE users; --")).toBe(DEFAULT_TIME_RANGE);
  });

  it("takes the first value when Next.js gives a repeated-query-key array", () => {
    expect(parseTimeRangeParam(["last7Days", "allTime"])).toBe("last7Days");
  });

  it("falls back to DEFAULT_TIME_RANGE for an array whose first value is invalid", () => {
    expect(parseTimeRangeParam(["not-a-range", "today"])).toBe(DEFAULT_TIME_RANGE);
  });

  it("falls back to DEFAULT_TIME_RANGE for an empty array", () => {
    expect(parseTimeRangeParam([])).toBe(DEFAULT_TIME_RANGE);
  });
});
