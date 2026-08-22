import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Invoice System Official Slice 5d — static source-contract coverage for
 * the one seeded itemized (non-archived) demo Invoice in `prisma/seed.ts`.
 * Reads the file's raw text only — this file NEVER imports, requires,
 * dynamically imports, executes, transpiles, or evaluates
 * `prisma/seed.ts`, which runs its own `main()` unconditionally at module
 * load time (real Supabase Auth Admin API calls, real Prisma writes)
 * with no `require.main === module` guard. Matches this repo's own
 * established migration-contract-test discipline (never executing
 * `migration.sql` directly either, for the identical underlying reason:
 * the source is unsafe to execute inside a test run).
 */

const seedSource = readFileSync(join(__dirname, "../../prisma/seed.ts"), "utf-8");

// Comments stripped once, up front — this file's own disclosure comments
// discuss (in prose) the exact field/module names ("finalizedAt",
// "pdfStoragePath", the substring "Storage" inside "pdfStoragePath"/
// "InvoicePdfArchiveObject") that the "forbidden content" checks below
// scan for, which would otherwise false-positive against prose rather
// than real code — the same comment-stripping discipline this repo's own
// migration-contract tests already established.
const seedSourceCodeOnly = seedSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const MARKER = "Invoice System Official Slice 5d";

describe("prisma/seed.ts — itemized demo Invoice contract (static)", () => {
  it("contains exactly one Slice 5d marker comment, identifying exactly one new demo Invoice block", () => {
    const matches = seedSource.split(MARKER).length - 1;
    expect(matches).toBe(1);
  });

  const markerIndex = seedSource.indexOf(MARKER);
  const createAnchor = markerIndex > -1 ? seedSource.indexOf("await prisma.invoice.create", markerIndex) : -1;
  const blockEnd = createAnchor > -1 ? seedSource.indexOf("\n\n", createAnchor) : -1;
  // Bounded slice: from the marker comment through the next blank-line
  // boundary after the create call — generously bounded rather than to
  // end of file, so an unrelated later edit elsewhere can't silently
  // widen or narrow what this test actually inspects.
  const block = markerIndex > -1 ? seedSource.slice(markerIndex, blockEnd > -1 ? blockEnd : seedSource.length) : "";
  const blockCodeOnly = block.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("the block contains exactly one new Invoice creation", () => {
    expect(markerIndex).toBeGreaterThan(-1);
    const createMatches = [...block.matchAll(/prisma\.invoice\.create/g)];
    expect(createMatches).toHaveLength(1);
  });

  it("is itemized via real nested InvoiceLineItem creation with at least one line", () => {
    expect(block).toMatch(/lineItems:\s*\{\s*create:/);
    expect(block).toMatch(/description:\s*"[^"]+"/);
  });

  it("line-item positions are explicit, deterministic, unique, and ordered (index-derived, never a hardcoded literal)", () => {
    expect(block).toMatch(/position:\s*index/);
    expect(block).not.toMatch(/position:\s*\d+/);
  });

  it("line descriptions/quantities/unit prices are deterministic literals, never random or date-derived", () => {
    expect(block).toMatch(/quantity:\s*"[\d.]+"/);
    expect(block).toMatch(/unitPrice:\s*"[\d.]+"/);
    expect(block).not.toMatch(/Math\.random/);
    expect(block).not.toMatch(/daysFromNow\(\)\s*\.(getTime|toISOString)/);
  });

  it("totals come from the real calculateInvoiceTotals() helper, never handwritten arithmetic", () => {
    expect(seedSource).toMatch(/import\s*\{\s*calculateInvoiceTotals\s*\}\s*from\s*"\.\.\/src\/lib\/invoices\/calculations"/);
    expect(block).toMatch(/calculateInvoiceTotals\(/);
  });

  it("persisted subtotal/discountAmount/taxAmount/total are sourced from that calculated result, internally consistent with ITEMIZED pricing mode", () => {
    expect(block).toMatch(/mode:\s*"lineItems"/);
    expect(block).not.toMatch(/mode:\s*"flat"/);
    expect(block).toMatch(/amount:\s*\w+\.total/);
    expect(block).toMatch(/subtotal:\s*\w+\.subtotal/);
    expect(block).toMatch(/discountAmount:\s*\w+\.discountAmount/);
    expect(block).toMatch(/taxAmount:\s*\w+\.taxAmount/);
  });

  it("organizationId/clientId/projectId reuse the existing primary seed topology variables, never a new literal id", () => {
    expect(block).toMatch(/organizationId(,|\s*:\s*organizationId)/);
    expect(block).toMatch(/clientId:\s*\w+\.id/);
    expect(block).toMatch(/projectId:\s*\w+\.id/);
    expect(block).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("the new invoiceNumber literal is not duplicated among actual seeded Invoice-number assignments anywhere in the file", () => {
    // Scoped precisely to real Invoice-number assignment sites — the
    // `invoiceNumber: "..."` key inside an Invoice create/createMany
    // payload — never a bare string search, so a comment, or
    // seedCollaborationDemo's own `invoiceNumber: "INV-1006"` passthrough
    // argument (metadata for an existing Notification, not a second
    // Invoice row), can never be miscounted as a duplicate seeded row.
    // Scoped to exactly the two functions that create real Invoice rows
    // (seedPrimaryUserData, seedSecondaryUserData) — main()'s own
    // seedCollaborationDemo(...) call (which passes an existing
    // invoiceNumber through as plain metadata) sits outside this range.
    const seedFnsStart = seedSource.indexOf("async function seedPrimaryUserData");
    const seedFnsEnd = seedSource.indexOf("async function seedPortalDemo");
    const seedFnsRegion = seedSource.slice(seedFnsStart, seedFnsEnd);
    const allInvoiceNumberAssignments = [...seedFnsRegion.matchAll(/invoiceNumber:\s*"([^"]+)"/g)].map((m) => m[1]);
    const uniqueValues = new Set(allInvoiceNumberAssignments);
    expect(uniqueValues.size).toBe(allInvoiceNumberAssignments.length);
    expect(allInvoiceNumberAssignments.length).toBeGreaterThan(0);
    expect(allInvoiceNumberAssignments).toContain("INV-1010");
  });

  it("the block sits inside seedPrimaryUserData's existing idempotency-guarded creation region", () => {
    const fnStart = seedSource.indexOf("async function seedPrimaryUserData");
    const fnGuard = seedSource.indexOf("if (existing > 0)", fnStart);
    const fnEnd = seedSource.indexOf("\nasync function seedSecondaryUserData");
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnGuard).toBeGreaterThan(fnStart);
    expect(markerIndex).toBeGreaterThan(fnGuard);
    expect(markerIndex).toBeLessThan(fnEnd);
  });

  it("is deliberately non-archived: no finalizedAt, no pdfStoragePath, no archive-ledger creation", () => {
    expect(blockCodeOnly).not.toMatch(/finalizedAt/);
    expect(blockCodeOnly).not.toMatch(/pdfStoragePath/);
    expect(blockCodeOnly).not.toMatch(/InvoicePdfArchiveObject/);
    expect(blockCodeOnly).not.toMatch(/issuerSnapshot|recipientSnapshot/);
  });

  it("uses a non-DRAFT status, making Portal visibility intent explicit", () => {
    expect(block).toMatch(/status:\s*"(SENT|PAID|OVERDUE|CANCELLED)"/);
    expect(block).not.toMatch(/status:\s*"DRAFT"/);
  });

  it("introduces no Resend/email/PDF-render/Storage/upload/Issue/archive invocation anywhere in the file", () => {
    expect(seedSourceCodeOnly).not.toMatch(/resend|Resend|sendEmail|render\(|uploadInvoicePdfObject|issueInvoice|archiveLegacyInvoice|Storage/);
  });
});
