import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Invoice System Slice 2a — a narrow source-contract test, matching this
 * repo's established convention (see
 * test/unit/invoice-slice1-migration-contract.test.ts and
 * test/unit/invoice-organization-migration-contract.test.ts): a stable
 * substring assertion against the file's own text, not a full-file
 * snapshot and not a behavioral test.
 *
 * What this proves: `calculations.ts` and `currencies.ts` import
 * `Prisma` from `@/generated/prisma/browser` — the entry point
 * `@/generated/prisma/client.ts`'s own header comment designates as
 * client-side-safe — and never from `@/generated/prisma/client`, whose
 * `node:process`/`node:path`/`node:url` imports make it unbundleable into
 * a Client Component (empirically reproduced: a throwaway `"use client"`
 * page importing `calculateInvoiceTotals()` while this file imported
 * `@/generated/prisma/client` failed `npm run build` with "the chunking
 * context (unknown) does not support external modules (request:
 * node:module)"; switching the import to `.../browser` made the same
 * build succeed).
 *
 * What this test does NOT prove: it is a static text check on these two
 * files alone, not a live bundled-consumer proof. It cannot catch a
 * regression where some OTHER file re-exports a server-only Prisma value
 * through these modules, and it says nothing about whether any real
 * Client Component actually imports and renders these modules correctly.
 * That permanent, load-bearing proof arrives in Slice 2b, where the real,
 * visible Invoice Client Component (the itemized line-item editor and its
 * live totals preview) imports and calls `calculateInvoiceTotals()`/
 * `formatInvoiceCurrencyAmount()` directly, and the ordinary `npm run
 * build` check every PR already requires exercises that actual production
 * module graph — no separate proof or check is needed once that lands.
 */

const CALCULATIONS_PATH = join(__dirname, "../../src/lib/invoices/calculations.ts");
const CURRENCIES_PATH = join(__dirname, "../../src/lib/invoices/currencies.ts");

const calculationsSource = readFileSync(CALCULATIONS_PATH, "utf-8");
const currenciesSource = readFileSync(CURRENCIES_PATH, "utf-8");

describe("src/lib/invoices/calculations.ts — client-safe Prisma import", () => {
  it("imports Prisma from @/generated/prisma/browser", () => {
    expect(calculationsSource).toContain('import { Prisma } from "@/generated/prisma/browser";');
  });

  it("never imports Prisma from the server-only @/generated/prisma/client", () => {
    expect(calculationsSource).not.toContain('from "@/generated/prisma/client"');
  });
});

describe("src/lib/invoices/currencies.ts — client-safe Prisma import", () => {
  it("imports Prisma from @/generated/prisma/browser", () => {
    expect(currenciesSource).toContain('import { Prisma } from "@/generated/prisma/browser";');
  });

  it("never imports Prisma from the server-only @/generated/prisma/client", () => {
    expect(currenciesSource).not.toContain('from "@/generated/prisma/client"');
  });
});
