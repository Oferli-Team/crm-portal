import { describe, expect, it, vi } from "vitest";

// src/lib/invoices/pdf/buffer-validation.ts imports the real "server-only"
// marker package — see test/unit/cron-auth.test.ts's own header comment
// for the identical precedent.
vi.mock("server-only", () => ({}));

import { validatePdfBuffer, MAX_PDF_BYTES } from "@/lib/invoices/pdf/buffer-validation";

function pdfBufferOfSize(totalBytes: number): Buffer {
  const buffer = Buffer.alloc(totalBytes, 0x20); // pad with ASCII spaces
  buffer.write("%PDF-1.3", 0, "latin1");
  return buffer;
}

describe("validatePdfBuffer", () => {
  it("accepts a minimal valid %PDF-signed buffer", () => {
    const buffer = Buffer.from("%PDF-1.3\n%%EOF", "latin1");
    expect(validatePdfBuffer(buffer)).toEqual({ ok: true });
  });

  it("rejects an empty buffer", () => {
    expect(validatePdfBuffer(Buffer.alloc(0))).toEqual({ ok: false, reason: "EMPTY" });
  });

  it("rejects a buffer with the wrong signature", () => {
    const buffer = Buffer.from("NOT-A-PDF-AT-ALL", "latin1");
    expect(validatePdfBuffer(buffer)).toEqual({ ok: false, reason: "INVALID_SIGNATURE" });
  });

  it("rejects a short buffer that can't possibly contain the signature", () => {
    const buffer = Buffer.from("%P", "latin1");
    expect(validatePdfBuffer(buffer)).toEqual({ ok: false, reason: "INVALID_SIGNATURE" });
  });

  it("accepts a buffer of exactly the maximum size boundary", () => {
    const buffer = pdfBufferOfSize(MAX_PDF_BYTES);
    expect(validatePdfBuffer(buffer)).toEqual({ ok: true });
  });

  it("rejects a buffer exactly one byte over the maximum size", () => {
    const buffer = pdfBufferOfSize(MAX_PDF_BYTES + 1);
    expect(validatePdfBuffer(buffer)).toEqual({ ok: false, reason: "TOO_LARGE" });
  });

  it("MAX_PDF_BYTES is documented as 15 MiB", () => {
    expect(MAX_PDF_BYTES).toBe(15 * 1024 * 1024);
  });
});
