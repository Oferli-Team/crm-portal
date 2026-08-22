import { Prisma } from "@/generated/prisma/browser";
import { formatInvoiceCurrencyAmount } from "@/lib/invoices/currencies";

/**
 * `@/generated/prisma/browser`'s own namespace exports `Decimal` as a
 * value only (no companion `export type Decimal = ...`), so `Prisma.Decimal`
 * cannot be written in a TYPE position here — see the identical, longer
 * comment in src/lib/invoices/calculations.ts and src/lib/invoices/currencies.ts.
 * `InstanceType<typeof Prisma.Decimal>` recovers the instance type.
 */
type Decimal = InstanceType<typeof Prisma.Decimal>;

type MoneyValue = Decimal | string | number;

export type InvoiceTotalsInput = {
  amount: MoneyValue;
  subtotal: MoneyValue | null;
  discountType: string;
  discountAmount: MoneyValue | null;
  discountValue: MoneyValue | null;
  taxRatePercent: MoneyValue | null;
  taxAmount: MoneyValue | null;
  taxLabel: string;
  currency: string;
};

export type InvoiceTotalsViewModel = {
  displayedSubtotal: string;
  discountRow: { label: string; amount: string } | null;
  taxRow: { label: string; amount: string } | null;
  total: string;
};

/**
 * Invoice System Slice 2b legacy-total display contract. `amount` is the
 * one field guaranteed non-null for every invoice ever created —
 * `subtotal` only exists from Slice 1 onward and, for a flat invoice, is
 * defined to equal `amount` once populated, so falling back to `amount`
 * is never even approximate, it's exact. No zero value is ever invented:
 * discount/tax rows are omitted entirely (not "$0.00") whenever the
 * persisted value is null or carries no real information (NONE-type
 * discount, absent tax).
 *
 * Extracted from src/components/invoices/invoice-read-only-view.tsx
 * (Invoice System Official Slice 3, sub-PR 3a) into its own pure,
 * browser-safe, non-component module — the PDF view-model builder
 * (src/lib/invoices/pdf/view-model.ts) reuses this exact same rounding/
 * omission logic and must not import anything from a Client-Component-
 * adjacent module. Behavior is unchanged: same inputs produce the same
 * outputs as before the move.
 */
export function buildInvoiceTotalsViewModel(invoice: InvoiceTotalsInput): InvoiceTotalsViewModel {
  const format = (value: MoneyValue): string => formatInvoiceCurrencyAmount(value, invoice.currency) ?? String(value);

  const displayedSubtotal = format(invoice.subtotal ?? invoice.amount);

  const discountRow =
    invoice.discountAmount == null || invoice.discountType === "NONE"
      ? null
      : {
          label:
            invoice.discountType === "PERCENTAGE" && invoice.discountValue != null
              ? `Discount (${String(invoice.discountValue)}%)`
              : "Discount",
          amount: format(invoice.discountAmount),
        };

  const taxRow =
    invoice.taxAmount == null || invoice.taxRatePercent == null
      ? null
      : { label: `${invoice.taxLabel} (${String(invoice.taxRatePercent)}%)`, amount: format(invoice.taxAmount) };

  return { displayedSubtotal, discountRow, taxRow, total: format(invoice.amount) };
}
