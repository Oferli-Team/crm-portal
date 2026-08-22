import { Prisma } from "@/generated/prisma/client";

/** One fixed instant, reused wherever a test needs a deterministic "now". */
export const FIXED_NOW = new Date("2026-06-15T12:00:00.000Z");

/**
 * Minimal shape validateAttachmentFile() actually accepts — no real
 * File/Blob needed; the current contract is a plain
 * `{ name, type, size }` object (see src/lib/storage/attachment-files.ts).
 */
export function makeAttachmentFile(
  overrides: Partial<{ name: string; type: string; size: number }> = {},
): { name: string; type: string; size: number } {
  return { name: "report.pdf", type: "application/pdf", size: 1024, ...overrides };
}

/** Prisma.Decimal factory — mirrors the real DB-side type for Invoice.amount. */
export function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}
