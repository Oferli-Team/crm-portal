import { describe, expect, it } from "vitest";
import { formatBucketLabel } from "@/lib/analytics/calculations/format-bucket-label";

describe("formatBucketLabel", () => {
  it("formats an hour bucket as a 12-hour clock label", () => {
    expect(formatBucketLabel(new Date("2026-08-12T00:00:00.000Z"), "hour")).toBe("12 AM");
    expect(formatBucketLabel(new Date("2026-08-12T13:00:00.000Z"), "hour")).toBe("1 PM");
    expect(formatBucketLabel(new Date("2026-08-12T12:00:00.000Z"), "hour")).toBe("12 PM");
    expect(formatBucketLabel(new Date("2026-08-12T23:00:00.000Z"), "hour")).toBe("11 PM");
  });

  it("formats a day bucket as 'Mon D'", () => {
    expect(formatBucketLabel(new Date("2026-08-05T00:00:00.000Z"), "day")).toBe("Aug 5");
    expect(formatBucketLabel(new Date("2026-01-01T00:00:00.000Z"), "day")).toBe("Jan 1");
  });

  it("formats a week bucket the same way as a day bucket (the bucket's own start date)", () => {
    expect(formatBucketLabel(new Date("2026-08-03T00:00:00.000Z"), "week")).toBe("Aug 3");
  });

  it("uses UTC, never the host timezone", () => {
    // 2026-01-01T00:30:00Z is still Jan 1 in UTC even if the host's local
    // timezone would roll it to Dec 31.
    expect(formatBucketLabel(new Date("2026-01-01T00:30:00.000Z"), "day")).toBe("Jan 1");
  });
});
