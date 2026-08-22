import type { PaymentDetailsFormState } from "@/types";

export type ParsedPaymentDetailsInput = {
  bankName: string;
  accountHolder: string;
  accountNumber: string;
  swiftBic: string;
  paymentInstructions: string | null;
};

export function parsePaymentDetailsForm(formData: FormData): {
  values: ParsedPaymentDetailsInput;
  fieldErrors: NonNullable<PaymentDetailsFormState["fieldErrors"]>;
} {
  const bankName = String(formData.get("bankName") ?? "").trim();
  const accountHolder = String(formData.get("accountHolder") ?? "").trim();
  const accountNumber = String(formData.get("accountNumber") ?? "").trim();
  const swiftBic = String(formData.get("swiftBic") ?? "").trim();
  const paymentInstructions = String(formData.get("paymentInstructions") ?? "").trim();

  const fieldErrors: NonNullable<PaymentDetailsFormState["fieldErrors"]> = {};

  if (!bankName) {
    fieldErrors.bankName = "Bank name is required.";
  }
  if (!accountHolder) {
    fieldErrors.accountHolder = "Account holder is required.";
  }
  if (!accountNumber) {
    fieldErrors.accountNumber = "Account number or IBAN is required.";
  }
  if (!swiftBic) {
    fieldErrors.swiftBic = "SWIFT/BIC is required.";
  }

  return {
    values: { bankName, accountHolder, accountNumber, swiftBic, paymentInstructions: paymentInstructions || null },
    fieldErrors,
  };
}
