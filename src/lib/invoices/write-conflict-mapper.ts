import "server-only";
import { Prisma } from "@/generated/prisma/client";

export type InvoiceWriteConflict = "INVOICE_NUMBER_CONFLICT" | "UNRECOGNIZED";

type DriverAdapterMeta = {
  driverAdapterError?: {
    cause?: { constraint?: { fields?: unknown } };
  };
};

function hasExactFields(fields: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(fields) &&
    fields.length === expected.length &&
    expected.every((field, index) => fields[index] === field)
  );
}

/**
 * Invoice System Official Slice 5c. Maps only the empirically verified
 * organization-wide Invoice-number P2002 shape — `error.meta.target` is
 * never populated on this project's Prisma/driver-adapter stack (proven
 * by PR 4a for single-column constraints, reconfirmed for this exact
 * two-column index during the Slice 5c design audit); the real,
 * distinguishing signal is `meta.driverAdapterError.cause.constraint.
 * fields`, an ordered array of quoted column names.
 *
 * Both Invoice writers (`invoices/new/actions.ts`,
 * `invoices/[id]/edit/actions.ts`) write InvoiceLineItem rows inside the
 * same transaction, which carries its own reachable
 * `@@unique([invoiceId, position])` constraint — any P2002 that isn't
 * positively identified as the Invoice-number conflict must fail closed
 * as UNRECOGNIZED rather than being mislabeled.
 */
export function mapInvoiceWriteError(error: unknown): InvoiceWriteConflict {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return "UNRECOGNIZED";
  }

  const fields = (error.meta as DriverAdapterMeta | undefined)?.driverAdapterError?.cause?.constraint?.fields;
  if (hasExactFields(fields, ['"organizationId"', '"invoiceNumber"'])) {
    return "INVOICE_NUMBER_CONFLICT";
  }

  return "UNRECOGNIZED";
}
