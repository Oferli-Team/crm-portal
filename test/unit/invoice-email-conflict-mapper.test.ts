import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@/generated/prisma/client";

vi.mock("server-only", () => ({}));

const { mapInvoiceEmailAttemptWriteError } = await import("@/lib/invoices/email/conflict-mapper");

function p2002(fields: string[]) {
  return new Prisma.PrismaClientKnownRequestError("bounded test error", {
    code: "P2002",
    clientVersion: "test",
    meta: { driverAdapterError: { cause: { constraint: { fields } } } },
  });
}

describe("mapInvoiceEmailAttemptWriteError", () => {
  it("recognizes only the empirically-proven idempotencyKey shape", () => {
    expect(mapInvoiceEmailAttemptWriteError(p2002(['"idempotencyKey"']))).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });

  it("recognizes only the empirically-proven pending-index shape", () => {
    expect(mapInvoiceEmailAttemptWriteError(p2002(['"invoiceId"']))).toBe("ALREADY_PENDING_CONFLICT");
  });

  it("fails closed for missing nested metadata", () => {
    expect(mapInvoiceEmailAttemptWriteError(p2002([]))).toBe("PERSISTENCE_FAILED");
  });

  it("fails closed for a classic meta.target shape", () => {
    const error = new Prisma.PrismaClientKnownRequestError("classic shape", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: ["idempotencyKey"] },
    });
    expect(mapInvoiceEmailAttemptWriteError(error)).toBe("PERSISTENCE_FAILED");
  });

  it("fails closed for unrelated and non-Prisma errors", () => {
    expect(mapInvoiceEmailAttemptWriteError(p2002(['"other"']))).toBe("PERSISTENCE_FAILED");
    expect(mapInvoiceEmailAttemptWriteError(new Error("nope"))).toBe("PERSISTENCE_FAILED");
  });
});
