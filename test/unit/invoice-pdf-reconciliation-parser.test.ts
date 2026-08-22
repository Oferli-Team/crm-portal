import { describe, expect, it, vi } from "vitest";
import type { ArchiveObjectLedgerRow } from "@/lib/invoices/pdf/reconcile-archive-objects";

// reconcile-archive-objects.ts imports the real "server-only" marker
// package — see test/unit/cron-auth.test.ts's own header comment for the
// identical, already-established precedent.
vi.mock("server-only", () => ({}));

const { parseAndValidateArchiveObjectPath } = await import("@/lib/invoices/pdf/reconcile-archive-objects");
const { buildInvoicePdfStoragePath } = await import("@/lib/invoices/pdf/storage");

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const INVOICE_ID = "22222222-2222-4222-8222-222222222222";
const ARCHIVE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ORG_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_INVOICE_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_ARCHIVE_ID = "66666666-6666-4666-8666-666666666666";

function row(overrides: Partial<ArchiveObjectLedgerRow> = {}): ArchiveObjectLedgerRow {
  const base: ArchiveObjectLedgerRow = {
    id: ARCHIVE_ID,
    organizationId: ORG_ID,
    invoiceId: INVOICE_ID,
    documentVersion: 1,
    storagePath: buildInvoicePdfStoragePath({
      organizationId: ORG_ID,
      invoiceId: INVOICE_ID,
      documentVersion: 1,
      archiveId: ARCHIVE_ID,
    }),
  };
  return { ...base, ...overrides };
}

describe("parseAndValidateArchiveObjectPath — valid rows", () => {
  it("recovers the exact identity for a well-formed, fully-consistent row", () => {
    const result = parseAndValidateArchiveObjectPath(row());
    expect(result).toEqual({
      ok: true,
      identity: { organizationId: ORG_ID, invoiceId: INVOICE_ID, documentVersion: 1, archiveId: ARCHIVE_ID },
    });
  });

  it("succeeds for a documentVersion other than 1, when the row's own field matches", () => {
    const path = buildInvoicePdfStoragePath({ organizationId: ORG_ID, invoiceId: INVOICE_ID, documentVersion: 5, archiveId: ARCHIVE_ID });
    const result = parseAndValidateArchiveObjectPath(row({ documentVersion: 5, storagePath: path }));
    expect(result).toEqual({
      ok: true,
      identity: { organizationId: ORG_ID, invoiceId: INVOICE_ID, documentVersion: 5, archiveId: ARCHIVE_ID },
    });
  });

  it("succeeds when row.invoiceId is null, recovering invoiceId from the path itself", () => {
    const result = parseAndValidateArchiveObjectPath(row({ invoiceId: null }));
    expect(result).toEqual({
      ok: true,
      identity: { organizationId: ORG_ID, invoiceId: INVOICE_ID, documentVersion: 1, archiveId: ARCHIVE_ID },
    });
  });
});

describe("parseAndValidateArchiveObjectPath — malformed / cross-tenant / drift rejections (fail closed, invariant_violation)", () => {
  it("rejects a completely malformed path", () => {
    const result = parseAndValidateArchiveObjectPath(row({ storagePath: "not/a/real/path.pdf" }));
    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects an attachment-shaped path (never matches the invoice-pdf namespace)", () => {
    const result = parseAndValidateArchiveObjectPath(row({ storagePath: `organizations/${ORG_ID}/attachments/${ARCHIVE_ID}.pdf` }));
    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a logo-shaped path (never matches the invoice-pdf namespace)", () => {
    const result = parseAndValidateArchiveObjectPath(row({ storagePath: `organizations/${ORG_ID}/logo/${ARCHIVE_ID}.png` }));
    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects an organizationId mismatch between the path and the row's own authoritative column", () => {
    const path = buildInvoicePdfStoragePath({ organizationId: OTHER_ORG_ID, invoiceId: INVOICE_ID, documentVersion: 1, archiveId: ARCHIVE_ID });
    const result = parseAndValidateArchiveObjectPath(row({ storagePath: path }));
    expect(result).toEqual({ ok: false, reason: "organization_mismatch" });
  });

  it("rejects an archiveId mismatch between the path and the row's own id", () => {
    const path = buildInvoicePdfStoragePath({ organizationId: ORG_ID, invoiceId: INVOICE_ID, documentVersion: 1, archiveId: OTHER_ARCHIVE_ID });
    const result = parseAndValidateArchiveObjectPath(row({ storagePath: path }));
    expect(result).toEqual({ ok: false, reason: "archive_id_mismatch" });
  });

  it("rejects a documentVersion mismatch between the path and the row's own field", () => {
    const path = buildInvoicePdfStoragePath({ organizationId: ORG_ID, invoiceId: INVOICE_ID, documentVersion: 2, archiveId: ARCHIVE_ID });
    const result = parseAndValidateArchiveObjectPath(row({ documentVersion: 1, storagePath: path }));
    expect(result).toEqual({ ok: false, reason: "document_version_mismatch" });
  });

  it("rejects a non-null row.invoiceId that disagrees with the path's own invoiceId segment", () => {
    const result = parseAndValidateArchiveObjectPath(row({ invoiceId: OTHER_INVOICE_ID }));
    expect(result).toEqual({ ok: false, reason: "invoice_id_mismatch" });
  });

  it("a round-trip mismatch (path parses and every component matches individually, but rebuilding does not reproduce it byte-for-byte) fails closed", () => {
    // A path with an extra trailing segment — every UUID/version component
    // still matches the row's own fields, but the fixed regex's own anchors
    // (^...$) mean this can never actually match at all, landing on
    // "malformed" rather than "round_trip_mismatch" in practice — this
    // test proves the whole path is rejected outright, not silently
    // truncated/accepted.
    const result = parseAndValidateArchiveObjectPath(row({ storagePath: `${row().storagePath}.extra` }));
    expect(result.ok).toBe(false);
  });
});
