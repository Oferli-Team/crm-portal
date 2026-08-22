import { prisma } from "@/lib/prisma";
import type { ParsedPaymentDetailsInput } from "@/lib/validation/payment-details";

export type PaymentDetailsData = {
  bankName: string;
  accountHolder: string;
  accountNumber: string;
  swiftBic: string;
  paymentInstructions: string | null;
} | null;

/**
 * OWNER-only for both read and write — callers must call
 * assertCanAccessPaymentDetails() first (this function itself does no
 * role check; the page and the Server Action each call it independently
 * — see authorization.ts's own doc comment for why this boundary is
 * never left to a single call site alone).
 */
export async function getPaymentDetails(organizationId: string): Promise<PaymentDetailsData> {
  const row = await prisma.organizationPaymentDetails.findUnique({
    where: { organizationId },
    select: { bankName: true, accountHolder: true, accountNumber: true, swiftBic: true, paymentInstructions: true },
  });
  return row ?? null;
}

/** A single `upsert()` is already atomic — no explicit $transaction wrapper needed for one statement against one table (unlike upsertCompanyProfile, which touches two). */
export async function upsertPaymentDetails(organizationId: string, input: ParsedPaymentDetailsInput): Promise<void> {
  await prisma.organizationPaymentDetails.upsert({
    where: { organizationId },
    update: {
      bankName: input.bankName,
      accountHolder: input.accountHolder,
      accountNumber: input.accountNumber,
      swiftBic: input.swiftBic,
      paymentInstructions: input.paymentInstructions,
    },
    create: {
      organizationId,
      bankName: input.bankName,
      accountHolder: input.accountHolder,
      accountNumber: input.accountNumber,
      swiftBic: input.swiftBic,
      paymentInstructions: input.paymentInstructions,
    },
  });
}
