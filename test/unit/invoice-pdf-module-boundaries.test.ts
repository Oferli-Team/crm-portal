import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Invoice System Official Slice 3, sub-PR 3a — source-contract tests
 * proving the module-boundary rules for this sub-PR's new files. These
 * are targeted, exact-file checks (not brittle repository-wide substring
 * bans) — each assertion names the exact file(s) it inspects.
 */

const REPO_ROOT = process.cwd();

function readSource(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

const SERVER_ONLY_MODULES = [
  "src/lib/invoices/pdf/document.tsx",
  "src/lib/invoices/pdf/fonts.ts",
  "src/lib/invoices/pdf/view-model.ts",
  "src/lib/invoices/pdf/snapshot-types.ts",
  "src/lib/invoices/pdf/classify-archival.ts",
  "src/lib/invoices/pdf/buffer-validation.ts",
];

const ALL_NEW_MODULES = [...SERVER_ONLY_MODULES, "src/lib/invoices/totals-view-model.ts"];

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(REPO_ROOT, dir))) {
    const relative = join(dir, entry);
    const stat = statSync(join(REPO_ROOT, relative));
    if (stat.isDirectory()) {
      walkTsFiles(relative, out);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(relative);
    }
  }
  return out;
}

describe("module-boundary — server-only markers", () => {
  it.each(SERVER_ONLY_MODULES)('%s begins its imports with `import "server-only";`', (file) => {
    const source = readSource(file);
    expect(source).toMatch(/^import "server-only";/m);
  });

  it("src/lib/invoices/totals-view-model.ts has NO server-only marker — it remains browser-safe", () => {
    const source = readSource("src/lib/invoices/totals-view-model.ts");
    expect(source).not.toContain('"server-only"');
  });
});

describe("module-boundary — no new module imports the server Prisma client", () => {
  it.each(ALL_NEW_MODULES)("%s does not import @/generated/prisma/client", (file) => {
    const source = readSource(file);
    expect(source).not.toContain("@/generated/prisma/client");
  });
});

describe("module-boundary — totals-view-model.ts stays a pure, browser-safe module", () => {
  const source = readSource("src/lib/invoices/totals-view-model.ts");

  it("imports no React module", () => {
    expect(source).not.toMatch(/from ["']react["']/);
  });

  it("uses only the browser-safe Prisma entry point for its Decimal type", () => {
    expect(source).toContain("@/generated/prisma/browser");
  });
});

describe("module-boundary — document.tsx and view-model.ts carry no forbidden content", () => {
  // Note: view-model.ts legitimately imports "@/generated/prisma/browser"
  // for the browser-safe Decimal type alias (matching currencies.ts's own
  // established convention) — that is NOT a database import (it pulls in
  // no Prisma Client, no database connection). The forbidden check below
  // targets the actual database-client import path ("@/lib/prisma", the
  // real query-capable singleton every DB-reading module in this codebase
  // imports) and the server Prisma Client entry point specifically, never
  // the bare substring "prisma".
  const forbidden = ["internalNotes", "pdfStoragePath", "supabase.co", "storage.from(", '"@/lib/prisma"', "@/generated/prisma/client"];

  /**
   * Both files' own header comments intentionally document these exact
   * exclusions in prose (e.g. "no internalNotes") — a bare substring check
   * against the raw file would flag its own explanatory comment as a
   * violation, which is exactly the kind of brittle check to avoid.
   * Stripping `//` and `/* *\/` comments first checks only real code.
   */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it.each(["src/lib/invoices/pdf/document.tsx", "src/lib/invoices/pdf/view-model.ts"])(
    "%s contains none of: internalNotes, pdfStoragePath, a Supabase Storage URL fragment, a Storage bucket call, or a database-client import, outside of comments",
    (file) => {
      const code = stripComments(readSource(file));
      for (const term of forbidden) {
        expect(code).not.toContain(term);
      }
    },
  );

  it("document.tsx performs no network fetch call", () => {
    const source = readSource("src/lib/invoices/pdf/document.tsx");
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it("view-model.ts performs no network fetch call", () => {
    const source = readSource("src/lib/invoices/pdf/view-model.ts");
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("module-boundary — only document.tsx and fonts.ts import @react-pdf/renderer", () => {
  const nonReactPdfModules = [
    "src/lib/invoices/pdf/view-model.ts",
    "src/lib/invoices/pdf/snapshot-types.ts",
    "src/lib/invoices/pdf/classify-archival.ts",
    "src/lib/invoices/pdf/buffer-validation.ts",
    "src/lib/invoices/totals-view-model.ts",
  ];

  it.each(nonReactPdfModules)("%s does not import @react-pdf/renderer", (file) => {
    expect(readSource(file)).not.toContain("@react-pdf/renderer");
  });

  it("document.tsx imports @react-pdf/renderer", () => {
    expect(readSource("src/lib/invoices/pdf/document.tsx")).toContain("@react-pdf/renderer");
  });

  it("fonts.ts imports @react-pdf/renderer", () => {
    expect(readSource("src/lib/invoices/pdf/fonts.ts")).toContain("@react-pdf/renderer");
  });
});

describe("module-boundary — no Client Component imports any new PDF module", () => {
  const clientComponentFiles = walkTsFiles("src").filter((file) => {
    const source = readSource(file);
    return /^"use client";/m.test(source);
  });

  it("at least one Client Component exists in the repo (sanity check that this scan is meaningful)", () => {
    expect(clientComponentFiles.length).toBeGreaterThan(0);
  });

  it.each(clientComponentFiles)("%s does not import from @/lib/invoices/pdf or @/lib/invoices/totals-view-model", (file) => {
    const source = readSource(file);
    expect(source).not.toContain("@/lib/invoices/pdf");
    expect(source).not.toContain("@/lib/invoices/totals-view-model");
  });
});

describe("module-boundary — no route/action other than the sub-PR 3b Issue action, the sub-PR 3c staff PDF route, the Portal Invoice PDF route, the Legacy Archive action, and the Bounded Archival Reconciliation/Cleanup cron routes imports the PDF modules", () => {
  // Sub-PR 3a's own version of this test asserted zero route/action
  // imports at all (nothing was wired yet). Sub-PR 3b intentionally wired
  // exactly one — the dedicated Issue Server Action — per its own
  // "the dedicated Issue service is the only new DRAFT -> SENT path"
  // requirement. Sub-PR 3c added exactly one more entry: the staff signed
  // PDF download Route Handler. Portal Invoice PDF access adds a third,
  // deliberate entry: the Portal signed PDF download Route Handler, which
  // must call classifyInvoiceArchival()/buildInvoicePdfStoragePath()/
  // createInvoicePdfSignedUrl() exactly like its staff sibling. Invoice
  // System Official Slice 3, Legacy Archive adds a fourth, deliberate
  // entry: the retroactive-archival Server Action, which imports
  // @/lib/invoices/pdf/legacy-archive-invoice. Bounded Archival
  // Reconciliation/Cleanup adds the fifth and sixth, deliberate entries:
  // the real and dry-run cron Route Handlers, which import
  // @/lib/invoices/pdf/reconcile-archive-objects. A precise allowlist (not
  // a broad directory allowance) still catches any OTHER route/action
  // accidentally reaching into src/lib/invoices/pdf/, which would be a
  // real scope violation.
  const EXPECTED_PDF_IMPORTING_FILES = [
    "src/app/(dashboard)/invoices/[id]/edit/issue-actions.ts",
    "src/app/(dashboard)/invoices/[id]/edit/legacy-archive-actions.ts",
    "src/app/api/invoices/[id]/pdf/route.ts",
    "src/app/api/portal/invoices/[id]/pdf/route.ts",
    "src/app/api/cron/invoice-pdf-reconciliation/route.ts",
    "src/app/api/cron/invoice-pdf-reconciliation/dry-run/route.ts",
  ];

  const routeAndActionFiles = walkTsFiles("src/app").filter(
    (file) => file.endsWith("route.ts") || file.endsWith("actions.ts") || file.endsWith("action.ts"),
  );

  it("at least one route/action file exists in the repo (sanity check that this scan is meaningful)", () => {
    expect(routeAndActionFiles.length).toBeGreaterThan(0);
  });

  it.each(EXPECTED_PDF_IMPORTING_FILES)("%s exists and does import from @/lib/invoices/pdf", (file) => {
    expect(routeAndActionFiles).toContain(file);
    expect(readSource(file)).toContain("@/lib/invoices/pdf");
  });

  it.each(routeAndActionFiles.filter((file) => !EXPECTED_PDF_IMPORTING_FILES.includes(file)))(
    "%s does not import from @/lib/invoices/pdf",
    (file) => {
      expect(readSource(file)).not.toContain("@/lib/invoices/pdf");
    },
  );
});

describe("module-boundary — src/components/invoices/invoice-read-only-view.tsx only imports the totals TYPE, not the pdf/ modules", () => {
  const source = readSource("src/components/invoices/invoice-read-only-view.tsx");

  it("does not import from @/lib/invoices/pdf", () => {
    expect(source).not.toContain("@/lib/invoices/pdf");
  });

  it("no longer defines buildInvoiceTotalsViewModel locally", () => {
    expect(source).not.toContain("export function buildInvoiceTotalsViewModel");
  });
});

describe("module-boundary — shared archive-compensation.ts helper (Invoice System Official Slice 3, Legacy Archive)", () => {
  it('archive-compensation.ts begins its imports with import "server-only";', () => {
    const source = readSource("src/lib/invoices/pdf/archive-compensation.ts");
    expect(source).toMatch(/^import "server-only";/m);
  });

  it("issue-invoice.ts imports compensateArchiveUpload from the shared module and no longer defines its own local compensation function", () => {
    const source = readSource("src/lib/invoices/pdf/issue-invoice.ts");
    expect(source).toContain('from "./archive-compensation"');
    expect(source).toContain("compensateArchiveUpload");
    expect(source).not.toMatch(/async function compensateUpload\(/);
  });

  it("legacy-archive-invoice.ts imports compensateArchiveUpload from the shared module and does not define its own local compensation function", () => {
    const source = readSource("src/lib/invoices/pdf/legacy-archive-invoice.ts");
    expect(source).toContain('from "./archive-compensation"');
    expect(source).toContain("compensateArchiveUpload");
    expect(source).not.toMatch(/async function compensate\w*\(/);
  });
});

describe("module-boundary — reconcile-archive-objects.ts (Bounded Archival Reconciliation/Cleanup)", () => {
  const source = readSource("src/lib/invoices/pdf/reconcile-archive-objects.ts");

  it('begins its imports with import "server-only";', () => {
    expect(source).toMatch(/^import "server-only";/m);
  });

  it("imports probeInvoicePdfObject and removeInvoicePdfObject from the shared storage module — never a duplicated implementation", () => {
    expect(source).toContain('from "./storage"');
    expect(source).toContain("probeInvoicePdfObject");
    expect(source).toContain("removeInvoicePdfObject");
  });

  it("is never imported by any Client Component ('use client' file)", () => {
    const clientComponentFiles = walkTsFiles("src").filter((file) => /^"use client";/m.test(readSource(file)));
    for (const file of clientComponentFiles) {
      expect(readSource(file)).not.toContain("@/lib/invoices/pdf/reconcile-archive-objects");
    }
  });
});
