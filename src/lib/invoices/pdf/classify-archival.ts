import "server-only";
import { parseIssuerSnapshot, parseRecipientSnapshot } from "./snapshot-types";

/**
 * Invoice System Official Slice 3, sub-PR 3a — the exhaustive archival
 * classifier (docs/invoicing-architecture.md §4.6, "Second Corrected
 * Design Report" §13). This is a single, exhaustive function — every
 * future consumer (both PDF routes, the read-only view, the Portal query
 * layer, once 3b/3c wire them) must call this instead of independently
 * re-deriving a narrower check, so no code path can ever fall through to
 * treating a partially/invalidly populated row as a valid archive or a
 * valid legacy-eligible row.
 *
 * The result never carries parsed issuer/recipient snapshot values —
 * callers that need the actual snapshot contents (a server-only render
 * path) must call parseIssuerSnapshot()/parseRecipientSnapshot()
 * themselves; this classifier only reports which of the four kinds a row
 * is, plus a coarse, non-leaking reason for an invariant violation.
 */

export type InvoiceArchivalClassification =
  | { kind: "draft" }
  | { kind: "legacy_eligible" }
  | { kind: "archived" }
  | {
      kind: "invariant_violation";
      reason: "draft_with_archive_fields" | "incomplete_archive_fields" | "snapshot_unparseable";
    };

export type InvoiceArchivalFields = {
  status: string;
  finalizedAt: Date | null;
  pdfStoragePath: string | null;
  pdfGeneratedAt: Date | null;
  issuerSnapshot: unknown;
  recipientSnapshot: unknown;
};

export function classifyInvoiceArchival(invoice: InvoiceArchivalFields): InvoiceArchivalClassification {
  const hasFinalizedAt = invoice.finalizedAt !== null;
  const hasPath = invoice.pdfStoragePath !== null;
  const hasGeneratedAt = invoice.pdfGeneratedAt !== null;
  const hasIssuerSnapshot = invoice.issuerSnapshot !== null;
  const hasRecipientSnapshot = invoice.recipientSnapshot !== null;

  const populatedCount = [hasFinalizedAt, hasPath, hasGeneratedAt, hasIssuerSnapshot, hasRecipientSnapshot].filter(
    Boolean,
  ).length;
  const allNull = populatedCount === 0;
  const allPresent = populatedCount === 5;

  if (invoice.status === "DRAFT") {
    return allNull ? { kind: "draft" } : { kind: "invariant_violation", reason: "draft_with_archive_fields" };
  }

  if (allNull) return { kind: "legacy_eligible" };

  if (!allPresent) return { kind: "invariant_violation", reason: "incomplete_archive_fields" };

  const issuer = parseIssuerSnapshot(invoice.issuerSnapshot);
  const recipient = parseRecipientSnapshot(invoice.recipientSnapshot);
  if (!issuer.ok || !recipient.ok) {
    return { kind: "invariant_violation", reason: "snapshot_unparseable" };
  }

  return { kind: "archived" };
}
