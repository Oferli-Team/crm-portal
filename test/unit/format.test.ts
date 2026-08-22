import { describe, expect, it } from "vitest";
import { formatCurrency, formatFileSize, formatStatusLabel } from "@/lib/format";

// Named in Stage 3's audit as a pure-function candidate but without its own
// lettered section in the plan — covered here since it's trivial, has zero
// dependencies, and is used across the dashboard and attachment UI.

describe("formatCurrency", () => {
  it("formats USD by default", () => {
    expect(formatCurrency(100)).toBe("$100.00");
  });

  it("formats a non-default currency", () => {
    expect(formatCurrency(100, "EUR")).toBe("€100.00");
  });

  it("formats zero and negative amounts", () => {
    expect(formatCurrency(0)).toBe("$0.00");
    expect(formatCurrency(-50)).toBe("-$50.00");
  });
});

describe("formatFileSize", () => {
  it("formats bytes below 1024 as-is", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1023)).toBe("1023 B");
  });

  it("formats kilobytes with one decimal place below 10 units", () => {
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
  });

  it("rounds to a whole number at 10 units and above", () => {
    expect(formatFileSize(15 * 1024)).toBe("15 KB");
  });

  it("formats megabytes", () => {
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("formats gigabytes and caps at the largest unit", () => {
    expect(formatFileSize(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
  });
});

describe("formatStatusLabel", () => {
  it("titlecases a single-word status", () => {
    expect(formatStatusLabel("ACTIVE")).toBe("Active");
  });

  it("titlecases and space-separates a multi-word status", () => {
    expect(formatStatusLabel("IN_PROGRESS")).toBe("In Progress");
  });
});
