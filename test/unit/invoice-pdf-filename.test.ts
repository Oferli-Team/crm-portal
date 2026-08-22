import { describe, expect, it, vi } from "vitest";

// src/lib/invoices/pdf/storage.ts imports the real "server-only" marker
// package — see test/unit/invoice-pdf-storage.test.ts's own identical
// precedent for why this must be mocked before the module is imported at
// all in a plain Vitest unit test.
vi.mock("server-only", () => ({}));

const { buildInvoicePdfDownloadFilename } = await import("@/lib/invoices/pdf/storage");

/**
 * Invoice System Official Slice 3, sub-PR 3c — the exact, deterministic
 * safe-filename algorithm (src/lib/invoices/pdf/storage.ts's own doc
 * comment on buildInvoicePdfDownloadFilename()). Every assertion below
 * pins one exact execution-order boundary, not a general "looks safe"
 * property.
 */

describe("buildInvoicePdfDownloadFilename — exact deterministic algorithm", () => {
  it("passes a normal ASCII invoice number through unchanged", () => {
    expect(buildInvoicePdfDownloadFilename("INV-2026-001")).toBe("Invoice-INV-2026-001.pdf");
  });

  it("collapses internal spaces to a single hyphen", () => {
    expect(buildInvoicePdfDownloadFilename("INV 2026 001")).toBe("Invoice-INV-2026-001.pdf");
  });

  it("collapses a slash run to one hyphen, never joining the two sides together", () => {
    // The critical "A/B" -> "A-B" property, never the character-joining "AB".
    expect(buildInvoicePdfDownloadFilename("A/B")).toBe("Invoice-A-B.pdf");
  });

  it("collapses a backslash run to one hyphen, never joining the two sides together", () => {
    expect(buildInvoicePdfDownloadFilename("A\\B")).toBe("Invoice-A-B.pdf");
  });

  it("collapses a mixed slash/backslash run to a single hyphen", () => {
    expect(buildInvoicePdfDownloadFilename("A/\\B")).toBe("Invoice-A-B.pdf");
  });

  it("strips quote characters, collapsing the surrounding run to one hyphen", () => {
    expect(buildInvoicePdfDownloadFilename('INV"2026"001')).toBe("Invoice-INV-2026-001.pdf");
  });

  it("strips a CR/LF run, collapsing it to one hyphen", () => {
    expect(buildInvoicePdfDownloadFilename("INV\r\n2026")).toBe("Invoice-INV-2026.pdf");
  });

  it("strips a TAB, collapsing the run to one hyphen", () => {
    expect(buildInvoicePdfDownloadFilename("INV \t2026")).toBe("Invoice-INV-2026.pdf");
  });

  it("strips a literal NUL control character, collapsing the run to one hyphen", () => {
    expect(buildInvoicePdfDownloadFilename("INV\x002026")).toBe("Invoice-INV-2026.pdf");
  });

  it("decomposes composed accented Latin characters and strips the combining marks, keeping the base letters", () => {
    // "É" (U+00C9) decomposes under NFKD to "E" + U+0301 (combining acute).
    expect(buildInvoicePdfDownloadFilename("INV-ÉTÉ-001")).toBe("Invoice-INV-ETE-001.pdf");
  });

  it("falls back to the fixed filename for Unicode-only input with no ASCII alphanumeric characters", () => {
    expect(buildInvoicePdfDownloadFilename("中文号码")).toBe("Invoice.pdf");
  });

  it("falls back to the fixed filename for empty input", () => {
    expect(buildInvoicePdfDownloadFilename("")).toBe("Invoice.pdf");
  });

  it("falls back to the fixed filename for whitespace-only input", () => {
    expect(buildInvoicePdfDownloadFilename("   ")).toBe("Invoice.pdf");
  });

  it("falls back to the fixed filename for separator-only input", () => {
    expect(buildInvoicePdfDownloadFilename("---///\\\\...")).toBe("Invoice.pdf");
  });

  it("collapses a long repeated unsafe/separator run to exactly one hyphen", () => {
    expect(buildInvoicePdfDownloadFilename("INV////////2026")).toBe("Invoice-INV-2026.pdf");
  });

  it("strips a leading unsafe run entirely, with no leading hyphen in the result", () => {
    expect(buildInvoicePdfDownloadFilename("///INV-2026")).toBe("Invoice-INV-2026.pdf");
  });

  it("strips a trailing unsafe run entirely, with no trailing hyphen in the result", () => {
    expect(buildInvoicePdfDownloadFilename("INV-2026///")).toBe("Invoice-INV-2026.pdf");
  });

  it("keeps an invoice number whose sanitized stem is exactly 100 characters, unmodified", () => {
    const stem = "A".repeat(100);
    const result = buildInvoicePdfDownloadFilename(stem);
    expect(result).toBe(`Invoice-${stem}.pdf`);
    expect(result.length).toBe(8 + 100 + 4);
  });

  it("truncates a sanitized stem longer than 100 characters to exactly 100", () => {
    const stem = "B".repeat(150);
    const result = buildInvoicePdfDownloadFilename(stem);
    expect(result).toBe(`Invoice-${"B".repeat(100)}.pdf`);
    expect(result.length).toBe(8 + 100 + 4);
  });

  it("re-strips a trailing hyphen newly exposed by truncation at exactly the 100-character boundary", () => {
    // Characters 1-99 are "C", character 100 is "-", followed by more
    // valid characters — after slicing to 100 chars the stem ends in a
    // hyphen that step 7 must strip again.
    const raw = "C".repeat(99) + "-" + "D".repeat(20);
    const result = buildInvoicePdfDownloadFilename(raw);
    const expectedStem = "C".repeat(99); // the trailing hyphen at index 99 is stripped after truncation
    expect(result).toBe(`Invoice-${expectedStem}.pdf`);
    expect(result.endsWith("-.pdf")).toBe(false);
  });

  it("the exact fallback filename is Invoice.pdf, nowhere Invoice-Invoice.pdf", () => {
    expect(buildInvoicePdfDownloadFilename("")).toBe("Invoice.pdf");
    expect(buildInvoicePdfDownloadFilename("")).not.toBe("Invoice-Invoice.pdf");
  });

  it("the maximum possible non-fallback result is exactly 112 ASCII bytes", () => {
    const result = buildInvoicePdfDownloadFilename("E".repeat(500));
    expect(result.length).toBe(112);
    expect(Buffer.byteLength(result, "utf8")).toBe(112);
  });

  it("every character of a non-fallback result is ASCII — no non-ASCII byte survives", () => {
    const result = buildInvoicePdfDownloadFilename("INV-éèê-中文-2026");
    expect(/^[\x00-\x7f]+$/.test(result)).toBe(true);
  });

  it("contains no slash, backslash, quote, or control character in the result", () => {
    const result = buildInvoicePdfDownloadFilename('INV/2026\\"001\r\n ');
    expect(result).not.toMatch(/[/\\"\r\n\x00-\x1f]/);
  });

  it("is deterministic — two calls with the same input return the identical result", () => {
    const input = "INV-2026-XYZ/é//001";
    expect(buildInvoicePdfDownloadFilename(input)).toBe(buildInvoicePdfDownloadFilename(input));
  });

  it("trims leading/trailing whitespace before sanitizing", () => {
    expect(buildInvoicePdfDownloadFilename("  INV-2026-001  ")).toBe("Invoice-INV-2026-001.pdf");
  });
});
