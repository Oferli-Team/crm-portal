import { Prisma } from "@/generated/prisma/browser";

/**
 * `@/generated/prisma/browser`'s own namespace (`prismaNamespaceBrowser.ts`)
 * exports `Decimal` as a value only (`export const Decimal = runtime.Decimal`)
 * — unlike `@/generated/prisma/client`'s namespace, it has no companion
 * `export type Decimal = ...`, so `Prisma.Decimal` cannot be written in a
 * TYPE position here (confirmed by `tsc --noEmit`: "'Prisma.Decimal' refers
 * to a value, but is being used as a type here"). `InstanceType<typeof
 * Prisma.Decimal>` recovers the instance type from the constructor's own
 * type without relying on a type export this generator doesn't provide for
 * the browser entry point. Every TYPE-position use of a Decimal in this
 * file uses this local `Decimal` alias; every VALUE-position use (`new
 * Prisma.Decimal(...)`, `Prisma.Decimal.ROUND_HALF_UP`,
 * `Prisma.Decimal.isDecimal(...)`) still reads `Prisma.Decimal` directly.
 */
type Decimal = InstanceType<typeof Prisma.Decimal>;

/**
 * Invoice System Slice 1 — Decimal calculation domain
 * (docs/invoicing-architecture.md §5). Pure, no I/O, no Prisma Client
 * instance import — safe to call from a Client Component for the live
 * preview (§5's own "importing this same pure function directly, no
 * network round-trip") as well as from a Server Action, which always
 * recomputes and discards any client-submitted total.
 *
 * `Prisma.Decimal` (decimal.js under this generator) is used end to end —
 * never JS floating-point arithmetic for money. A plain `number` input is
 * accepted at the boundary only because converting a single decimal
 * literal (e.g. `85`, `0.015`) via `new Prisma.Decimal(value)` uses that
 * number's own shortest round-trip string representation (verified:
 * `new Prisma.Decimal(0.1).toString() === "0.1"`), which is exact for any
 * ordinary decimal literal. This does NOT make prior floating-point
 * arithmetic upstream of this function safe — if a caller passes the
 * *result* of JS float math (e.g. `0.1 + 0.2`), the extra garbage digits
 * that produces are still caught and rejected by this module's own
 * decimal-place validation below, the same as any other malformed input.
 * Callers that already hold a `string`/`Prisma.Decimal` (e.g. Server
 * Action `FormData` values, already-persisted rows) should prefer passing
 * those directly rather than a `number`.
 */

export type DecimalInput = Decimal | string | number;

export type LineItemInput = {
  description: string;
  quantity: DecimalInput;
  unitPrice: DecimalInput;
};

export type SubtotalSource =
  | { mode: "lineItems"; lineItems: LineItemInput[] }
  | { mode: "flat"; amount: DecimalInput };

export type DiscountInput =
  | { type: "NONE" }
  | { type: "PERCENTAGE"; value: DecimalInput }
  | { type: "FIXED"; value: DecimalInput };

export type InvoiceCalculationInput = {
  subtotalSource: SubtotalSource;
  discount: DiscountInput;
  taxRatePercent: DecimalInput | null;
};

export type CalculatedLineItem = {
  description: string;
  quantity: Decimal;
  unitPrice: Decimal;
  lineTotal: Decimal;
};

export type InvoiceCalculationError =
  | { code: "EMPTY_LINE_ITEMS" }
  | { code: "TOO_MANY_LINE_ITEMS" }
  | { code: "EMPTY_DESCRIPTION"; index: number }
  | { code: "DESCRIPTION_TOO_LONG"; index: number }
  | { code: "ZERO_OR_NEGATIVE_QUANTITY"; index: number }
  | { code: "QUANTITY_TOO_PRECISE"; index: number }
  | { code: "QUANTITY_OUT_OF_RANGE"; index: number }
  | { code: "NEGATIVE_UNIT_PRICE"; index: number }
  | { code: "UNIT_PRICE_TOO_PRECISE"; index: number }
  | { code: "UNIT_PRICE_OUT_OF_RANGE"; index: number }
  | { code: "INVALID_FLAT_AMOUNT" }
  | { code: "DISCOUNT_PERCENTAGE_OUT_OF_RANGE" }
  | { code: "DISCOUNT_VALUE_INVALID" }
  | { code: "DISCOUNT_EXCEEDS_SUBTOTAL" }
  | { code: "TAX_RATE_OUT_OF_RANGE" }
  | { code: "TOTAL_OUT_OF_RANGE" };

export type InvoiceCalculationResult =
  | {
      ok: true;
      lineItems: CalculatedLineItem[];
      subtotal: Decimal;
      discountAmount: Decimal;
      taxAmount: Decimal;
      total: Decimal;
    }
  | { ok: false; error: InvoiceCalculationError };

export const MAX_LINE_ITEMS = 200;
export const MAX_DESCRIPTION_LENGTH = 500;

// Decimal(10,2) ceiling: 10 total digits, 2 after the decimal point.
const MONEY_MAX = new Prisma.Decimal("99999999.99");
const MONEY_DECIMAL_PLACES = 2;

// Decimal(10,3) ceiling: 10 total digits, 3 after the decimal point.
const QUANTITY_MAX = new Prisma.Decimal("9999999.999");
const QUANTITY_DECIMAL_PLACES = 3;

const PERCENT_MIN = new Prisma.Decimal(0);
const PERCENT_MAX = new Prisma.Decimal(100);
const PERCENT_DECIMAL_PLACES = 2;

const ZERO = new Prisma.Decimal(0);

/**
 * Converts a DecimalInput to a Prisma.Decimal, or null if it isn't a valid
 * finite decimal.
 *
 * Uses `Prisma.Decimal.isDecimal(input)` rather than
 * `input instanceof Prisma.Decimal` deliberately — empirically verified
 * (via a throwaway Vitest spec, not assumed) that under this repo's actual
 * Vitest module resolution, `Prisma.Decimal` re-exported from
 * `@/generated/prisma/browser` (this module's own import, required for
 * Client Component bundling — see this file's header comment) and
 * `Prisma.Decimal` re-exported from `@/generated/prisma/client` (still
 * used by Server Action code elsewhere in this app to construct Decimal
 * values) are NOT the same class reference in that environment — a plain
 * `instanceof` check fails for a perfectly valid Decimal instance
 * constructed via the other entry point, silently treating it as invalid
 * input. `Decimal.isDecimal()` is decimal.js's own duck-typing-based
 * cross-instance check (a proper `object is Decimal` type predicate, see
 * `@prisma/client-runtime-utils`'s own `.d.ts`) built exactly for this
 * "two copies of the same class" scenario, and was verified to recognize
 * a Decimal from either entry point correctly. This must not be reverted
 * to `instanceof` even though both entry points were also verified to
 * resolve to the identical class object in an isolated `tsx` script
 * outside Vitest/Next.js's own module graphs — that isolated result does
 * not hold inside this app's real toolchain.
 */
function toDecimal(input: DecimalInput): Decimal | null {
  if (Prisma.Decimal.isDecimal(input)) {
    return input.isFinite() ? input : null;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    return new Prisma.Decimal(input);
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed === "") return null;
    try {
      const decimal = new Prisma.Decimal(trimmed);
      return decimal.isFinite() ? decimal : null;
    } catch {
      return null;
    }
  }
  return null;
}

function round2(value: Decimal): Decimal {
  return value.toDecimalPlaces(MONEY_DECIMAL_PLACES, Prisma.Decimal.ROUND_HALF_UP);
}

function isValidPercent(value: Decimal): boolean {
  return (
    value.greaterThanOrEqualTo(PERCENT_MIN) &&
    value.lessThanOrEqualTo(PERCENT_MAX) &&
    value.decimalPlaces() <= PERCENT_DECIMAL_PLACES
  );
}

function resolveLineItems(
  rawLineItems: LineItemInput[],
): { ok: true; lineItems: CalculatedLineItem[]; subtotal: Decimal } | { ok: false; error: InvoiceCalculationError } {
  if (rawLineItems.length === 0) {
    return { ok: false, error: { code: "EMPTY_LINE_ITEMS" } };
  }
  if (rawLineItems.length > MAX_LINE_ITEMS) {
    return { ok: false, error: { code: "TOO_MANY_LINE_ITEMS" } };
  }

  const lineItems: CalculatedLineItem[] = [];
  let subtotal = ZERO;

  for (let index = 0; index < rawLineItems.length; index++) {
    const raw = rawLineItems[index];
    const description = raw.description.trim();
    if (description.length === 0) {
      return { ok: false, error: { code: "EMPTY_DESCRIPTION", index } };
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return { ok: false, error: { code: "DESCRIPTION_TOO_LONG", index } };
    }

    const quantity = toDecimal(raw.quantity);
    if (quantity === null || quantity.lessThanOrEqualTo(0)) {
      return { ok: false, error: { code: "ZERO_OR_NEGATIVE_QUANTITY", index } };
    }
    if (quantity.decimalPlaces() > QUANTITY_DECIMAL_PLACES) {
      return { ok: false, error: { code: "QUANTITY_TOO_PRECISE", index } };
    }
    if (quantity.greaterThan(QUANTITY_MAX)) {
      return { ok: false, error: { code: "QUANTITY_OUT_OF_RANGE", index } };
    }

    const unitPrice = toDecimal(raw.unitPrice);
    if (unitPrice === null || unitPrice.lessThan(0)) {
      return { ok: false, error: { code: "NEGATIVE_UNIT_PRICE", index } };
    }
    if (unitPrice.decimalPlaces() > MONEY_DECIMAL_PLACES) {
      return { ok: false, error: { code: "UNIT_PRICE_TOO_PRECISE", index } };
    }
    if (unitPrice.greaterThan(MONEY_MAX)) {
      return { ok: false, error: { code: "UNIT_PRICE_OUT_OF_RANGE", index } };
    }

    // Per-line rounding, not deferred — this is what's printed on the PDF
    // row and must match what's summed into subtotal (§5).
    const lineTotal = round2(quantity.times(unitPrice));
    if (lineTotal.greaterThan(MONEY_MAX)) {
      return { ok: false, error: { code: "TOTAL_OUT_OF_RANGE" } };
    }

    lineItems.push({ description, quantity, unitPrice, lineTotal });
    subtotal = subtotal.plus(lineTotal);
  }

  return { ok: true, lineItems, subtotal };
}

/**
 * Computes every invoice total from either an itemized line-item set or a
 * flat amount (docs/invoicing-architecture.md §5). Never persists
 * anything, never throws for an expected validation failure — every
 * expected failure returns `{ ok: false, error }`. The server is always
 * the caller that decides what to persist; any client-computed preview
 * using this same function is never trusted as-is.
 */
export function calculateInvoiceTotals(input: InvoiceCalculationInput): InvoiceCalculationResult {
  let subtotal: Decimal;
  let lineItems: CalculatedLineItem[] = [];

  if (input.subtotalSource.mode === "lineItems") {
    const resolved = resolveLineItems(input.subtotalSource.lineItems);
    if (!resolved.ok) return resolved;
    lineItems = resolved.lineItems;
    subtotal = resolved.subtotal;
  } else {
    const amount = toDecimal(input.subtotalSource.amount);
    if (
      amount === null ||
      amount.lessThan(0) ||
      amount.decimalPlaces() > MONEY_DECIMAL_PLACES ||
      amount.greaterThan(MONEY_MAX)
    ) {
      return { ok: false, error: { code: "INVALID_FLAT_AMOUNT" } };
    }
    subtotal = amount;
  }

  if (subtotal.greaterThan(MONEY_MAX)) {
    return { ok: false, error: { code: "TOTAL_OUT_OF_RANGE" } };
  }

  // Discount — computed on subtotal (§5).
  let discountAmount = ZERO;
  if (input.discount.type === "PERCENTAGE") {
    const value = toDecimal(input.discount.value);
    if (value === null || !isValidPercent(value)) {
      return { ok: false, error: { code: "DISCOUNT_PERCENTAGE_OUT_OF_RANGE" } };
    }
    discountAmount = round2(subtotal.times(value).dividedBy(100));
  } else if (input.discount.type === "FIXED") {
    const value = toDecimal(input.discount.value);
    if (value === null || value.lessThan(0) || value.decimalPlaces() > MONEY_DECIMAL_PLACES) {
      return { ok: false, error: { code: "DISCOUNT_VALUE_INVALID" } };
    }
    if (value.greaterThan(subtotal)) {
      return { ok: false, error: { code: "DISCOUNT_EXCEEDS_SUBTOTAL" } };
    }
    discountAmount = value;
  }

  if (discountAmount.greaterThan(MONEY_MAX)) {
    return { ok: false, error: { code: "TOTAL_OUT_OF_RANGE" } };
  }

  // Tax — exclusive, computed on (subtotal - discountAmount), after discount (§5).
  let taxAmount = ZERO;
  if (input.taxRatePercent !== null) {
    const rate = toDecimal(input.taxRatePercent);
    if (rate === null || !isValidPercent(rate)) {
      return { ok: false, error: { code: "TAX_RATE_OUT_OF_RANGE" } };
    }
    const taxableBase = subtotal.minus(discountAmount);
    taxAmount = round2(taxableBase.times(rate).dividedBy(100));
  }

  if (taxAmount.greaterThan(MONEY_MAX)) {
    return { ok: false, error: { code: "TOTAL_OUT_OF_RANGE" } };
  }

  const total = subtotal.minus(discountAmount).plus(taxAmount);
  // Zero total is legal (a fully comped invoice, §5). Negative is
  // structurally unreachable given the FIXED-discount bound above, but
  // checked anyway as defense in depth.
  if (total.lessThan(0) || total.greaterThan(MONEY_MAX)) {
    return { ok: false, error: { code: "TOTAL_OUT_OF_RANGE" } };
  }

  return { ok: true, lineItems, subtotal, discountAmount, taxAmount, total };
}
