import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Invoice System — Duplicate-as-new-DRAFT (completing official Slice 2,
 * docs/invoicing-architecture.md §3.2/§14). The one Prisma-touching
 * boundary this feature adds — a small, organization-scoped, CANCELLED-
 * only source loader, matching this codebase's own established
 * lib-module-with-a-direct-prisma-import convention (e.g.
 * src/lib/organization-setup/company-profile.ts's `getCompanyProfile()`).
 *
 * `DUPLICATE_SOURCE_SELECT` is the single source of truth for both the
 * query and its result type — `DuplicateSourceInvoice` is inferred from
 * it via `Prisma.InvoiceGetPayload`, not hand-maintained separately, so
 * the two can never drift apart. `select`, never `include` — `include`
 * would return every scalar column of `Invoice` (internalNotes,
 * finalization/archive fields, subtotal/discountAmount/taxAmount, etc.)
 * regardless of what this feature actually needs.
 */
const DUPLICATE_SOURCE_SELECT = {
  id: true,
  invoiceNumber: true,
  projectId: true,
  amount: true,
  currency: true,
  notes: true,
  discountType: true,
  discountValue: true,
  taxRatePercent: true,
  taxLabel: true,
  lineItems: {
    orderBy: { position: "asc" },
    select: {
      description: true,
      quantity: true,
      unitPrice: true,
    },
  },
} satisfies Prisma.InvoiceSelect;

export type DuplicateSourceInvoice = Prisma.InvoiceGetPayload<{ select: typeof DUPLICATE_SOURCE_SELECT }>;

/**
 * Returns the CANCELLED, organization-scoped source invoice a Duplicate
 * page may prefill from, or `null` for every other case — DRAFT/SENT/
 * PAID/OVERDUE, a cross-organization id, or a nonexistent id are all
 * structurally indistinguishable from this function's own return value.
 * `project: { organizationId }` is retained as defense in depth, matching
 * every other Invoice query in this codebase, even though it is never
 * itself selected into the result. Currency support/normalization is
 * deliberately NOT this function's concern — an authorized CANCELLED row
 * is returned exactly as persisted, including an unsupported or
 * non-canonical (e.g. lowercase, padded) currency string; that judgment
 * belongs entirely to the page that calls this loader.
 */
export async function getDuplicateSourceInvoice(
  invoiceId: string,
  organizationId: string,
): Promise<DuplicateSourceInvoice | null> {
  return prisma.invoice.findFirst({
    where: { id: invoiceId, organizationId, project: { organizationId }, status: "CANCELLED" },
    select: DUPLICATE_SOURCE_SELECT,
  });
}
