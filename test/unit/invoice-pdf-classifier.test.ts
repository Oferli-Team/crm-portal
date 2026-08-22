import { describe, expect, it, vi } from "vitest";

// src/lib/invoices/pdf/classify-archival.ts imports the real "server-only"
// marker package (transitively, via snapshot-types.ts too) — see
// test/unit/cron-auth.test.ts's own header comment for the identical
// precedent.
vi.mock("server-only", () => ({}));

import { classifyInvoiceArchival, type InvoiceArchivalFields } from "@/lib/invoices/pdf/classify-archival";

const VALID_ISSUER_SNAPSHOT = {
  schemaVersion: 1,
  legalName: "Acme Corp",
  address: { streetAddress: null, city: null, state: null, postalCode: null },
  country: null,
  taxId: null,
  supportEmail: null,
  phone: null,
  website: null,
  brandColor: null,
  payment: null,
  logo: { included: false, reason: "no_logo_configured" },
};

const VALID_RECIPIENT_SNAPSHOT = {
  schemaVersion: 1,
  billingName: "Jane Doe",
  email: null,
  address: { streetAddress: null, city: null, state: null, postalCode: null },
  country: null,
  taxId: null,
};

const MALFORMED_SNAPSHOT = { schemaVersion: 1, notEvenClose: true };

const FULL_ARCHIVE_FIELDS = {
  finalizedAt: new Date("2026-08-01T00:00:00.000Z"),
  pdfStoragePath: "organizations/org-1/invoice-pdf/inv-1/1/archive-1/invoice.pdf",
  pdfGeneratedAt: new Date("2026-08-01T00:00:00.000Z"),
  issuerSnapshot: VALID_ISSUER_SNAPSHOT,
  recipientSnapshot: VALID_RECIPIENT_SNAPSHOT,
};

/** All 5 archive-field keys, in a fixed order, used to enumerate every one of the 32 presence/absence bitmasks. */
const ARCHIVE_FIELD_KEYS = ["finalizedAt", "pdfStoragePath", "pdfGeneratedAt", "issuerSnapshot", "recipientSnapshot"] as const;

type ArchiveFieldValues = Omit<InvoiceArchivalFields, "status">;

function fieldsForBitmask(bitmask: number): ArchiveFieldValues {
  const result = {} as ArchiveFieldValues;
  ARCHIVE_FIELD_KEYS.forEach((key, index) => {
    const present = (bitmask & (1 << index)) !== 0;
    if (!present) {
      result[key] = null;
      return;
    }
    if (key === "finalizedAt" || key === "pdfGeneratedAt") result[key] = FULL_ARCHIVE_FIELDS[key];
    else if (key === "pdfStoragePath") result[key] = FULL_ARCHIVE_FIELDS.pdfStoragePath;
    else if (key === "issuerSnapshot") result[key] = FULL_ARCHIVE_FIELDS.issuerSnapshot;
    else result[key] = FULL_ARCHIVE_FIELDS.recipientSnapshot;
  });
  return result;
}

function expectedKindForBitmask(status: string, bitmask: number): "draft" | "legacy_eligible" | "archived" | "invariant_violation" {
  const allNull = bitmask === 0;
  const allPresent = bitmask === 0b11111;

  if (status === "DRAFT") return allNull ? "draft" : "invariant_violation";
  if (allNull) return "legacy_eligible";
  if (!allPresent) return "invariant_violation";
  return "archived"; // all present, valid snapshots (this table uses valid snapshots throughout)
}

describe("classifyInvoiceArchival — exhaustive 32-bitmask table", () => {
  for (const status of ["DRAFT", "SENT"]) {
    describe(`status = ${status}`, () => {
      for (let bitmask = 0; bitmask < 32; bitmask++) {
        const label = ARCHIVE_FIELD_KEYS.map((key, index) => `${key}=${(bitmask & (1 << index)) !== 0 ? "SET" : "null"}`).join(
          ", ",
        );
        it(`bitmask ${bitmask.toString(2).padStart(5, "0")} (${label})`, () => {
          const fields: InvoiceArchivalFields = { status, ...fieldsForBitmask(bitmask) };
          const result = classifyInvoiceArchival(fields);
          const expectedKind = expectedKindForBitmask(status, bitmask);
          expect(result.kind).toBe(expectedKind);

          if (expectedKind === "invariant_violation") {
            if (status === "DRAFT") {
              expect((result as { reason: string }).reason).toBe("draft_with_archive_fields");
            } else {
              expect((result as { reason: string }).reason).toBe("incomplete_archive_fields");
            }
          }
        });
      }
    });
  }
});

describe("classifyInvoiceArchival — PAID/OVERDUE/CANCELLED behave identically to SENT", () => {
  for (const status of ["PAID", "OVERDUE", "CANCELLED"]) {
    for (let bitmask = 0; bitmask < 32; bitmask++) {
      it(`status=${status}, bitmask ${bitmask.toString(2).padStart(5, "0")} matches SENT's own result`, () => {
        const sentResult = classifyInvoiceArchival({ status: "SENT", ...fieldsForBitmask(bitmask) });
        const otherResult = classifyInvoiceArchival({ status, ...fieldsForBitmask(bitmask) });
        expect(otherResult).toEqual(sentResult);
      });
    }
  }
});

describe("classifyInvoiceArchival — snapshot validity for the all-present case", () => {
  it("classifies as archived when all five fields are present and both snapshots strictly parse", () => {
    const result = classifyInvoiceArchival({ status: "SENT", ...FULL_ARCHIVE_FIELDS });
    expect(result).toEqual({ kind: "archived" });
  });

  it("classifies as invariant_violation/snapshot_unparseable when the issuer snapshot is malformed", () => {
    const result = classifyInvoiceArchival({ status: "SENT", ...FULL_ARCHIVE_FIELDS, issuerSnapshot: MALFORMED_SNAPSHOT });
    expect(result).toEqual({ kind: "invariant_violation", reason: "snapshot_unparseable" });
  });

  it("classifies as invariant_violation/snapshot_unparseable when the recipient snapshot is malformed", () => {
    const result = classifyInvoiceArchival({ status: "SENT", ...FULL_ARCHIVE_FIELDS, recipientSnapshot: MALFORMED_SNAPSHOT });
    expect(result).toEqual({ kind: "invariant_violation", reason: "snapshot_unparseable" });
  });

  it("classifies as invariant_violation/snapshot_unparseable when both snapshots are malformed", () => {
    const result = classifyInvoiceArchival({
      status: "SENT",
      ...FULL_ARCHIVE_FIELDS,
      issuerSnapshot: MALFORMED_SNAPSHOT,
      recipientSnapshot: MALFORMED_SNAPSHOT,
    });
    expect(result).toEqual({ kind: "invariant_violation", reason: "snapshot_unparseable" });
  });

  it("classifies as invariant_violation/snapshot_unparseable when a snapshot has an unrecognized schemaVersion", () => {
    const result = classifyInvoiceArchival({
      status: "SENT",
      ...FULL_ARCHIVE_FIELDS,
      issuerSnapshot: { ...VALID_ISSUER_SNAPSHOT, schemaVersion: 2 },
    });
    expect(result).toEqual({ kind: "invariant_violation", reason: "snapshot_unparseable" });
  });
});

describe("classifyInvoiceArchival — result never carries snapshot contents", () => {
  it("the archived result has no issuer/recipient field of any kind", () => {
    const result = classifyInvoiceArchival({ status: "SENT", ...FULL_ARCHIVE_FIELDS });
    expect(Object.keys(result)).toEqual(["kind"]);
    expect(JSON.stringify(result)).not.toContain("Acme Corp");
    expect(JSON.stringify(result)).not.toContain("Jane Doe");
  });

  it("an invariant_violation result carries only kind/reason, never the raw snapshot values", () => {
    const result = classifyInvoiceArchival({ status: "SENT", ...FULL_ARCHIVE_FIELDS, issuerSnapshot: MALFORMED_SNAPSHOT });
    expect(Object.keys(result).sort()).toEqual(["kind", "reason"]);
  });
});
