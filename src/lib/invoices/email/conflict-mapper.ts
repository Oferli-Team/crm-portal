import "server-only";
import { Prisma } from "@/generated/prisma/client";

export type InvoiceEmailWriteConflict =
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "ALREADY_PENDING_CONFLICT"
  | "PERSISTENCE_FAILED";

type DriverAdapterMeta = {
  driverAdapterError?: {
    cause?: { constraint?: { fields?: unknown } };
  };
};

function hasExactField(fields: unknown, expected: string): boolean {
  return Array.isArray(fields) && fields.length === 1 && fields[0] === expected;
}

/** Maps only the two P2002 shapes empirically proven by PR 4a. */
export function mapInvoiceEmailAttemptWriteError(error: unknown): InvoiceEmailWriteConflict {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return "PERSISTENCE_FAILED";
  }

  const fields = (error.meta as DriverAdapterMeta | undefined)?.driverAdapterError?.cause?.constraint?.fields;
  if (hasExactField(fields, '"idempotencyKey"')) return "IDEMPOTENCY_KEY_CONFLICT";
  if (hasExactField(fields, '"invoiceId"')) return "ALREADY_PENDING_CONFLICT";
  return "PERSISTENCE_FAILED";
}
