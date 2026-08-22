import "server-only";

/**
 * Invoice System Official Slice 3, sub-PR 3a — structural PDF buffer
 * validation. This module proves ONLY that a Buffer is non-empty, begins
 * with the `%PDF` magic-number signature, and stays within a documented
 * size ceiling — it does not parse, does not extract text, and does not
 * verify visible content in any way. No PDF-parsing dependency is used
 * (per the approved 3a scope: no PDF parser dependency).
 */

// 15 MiB — generously above any realistic text+one-logo invoice PDF, low
// enough to catch a genuinely degenerate render (e.g. a corrupt/oversized
// embedded resource) before it's ever uploaded to Storage.
export const MAX_PDF_BYTES = 15 * 1024 * 1024;

const PDF_SIGNATURE = "%PDF";

export type PdfBufferValidationResult =
  | { ok: true }
  | { ok: false; reason: "EMPTY" | "INVALID_SIGNATURE" | "TOO_LARGE" };

/**
 * Never logs any byte of `buffer` — only the discriminated result above
 * is ever returned. Never parses or trusts anything about `buffer`'s
 * content beyond its length and its first four bytes.
 */
export function validatePdfBuffer(buffer: Buffer): PdfBufferValidationResult {
  if (buffer.length === 0) return { ok: false, reason: "EMPTY" };

  const signature = buffer.subarray(0, PDF_SIGNATURE.length).toString("latin1");
  if (signature !== PDF_SIGNATURE) return { ok: false, reason: "INVALID_SIGNATURE" };

  if (buffer.length > MAX_PDF_BYTES) return { ok: false, reason: "TOO_LARGE" };

  return { ok: true };
}
