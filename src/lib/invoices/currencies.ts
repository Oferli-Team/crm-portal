import { Prisma } from "@/generated/prisma/browser";

/**
 * `@/generated/prisma/browser`'s own namespace exports `Decimal` as a
 * value only (no companion `export type Decimal = ...`), so `Prisma.Decimal`
 * cannot be written in a TYPE position here — see the identical, longer
 * comment in src/lib/invoices/calculations.ts. `InstanceType<typeof
 * Prisma.Decimal>` recovers the instance type. Every TYPE-position Decimal
 * in this file uses this local alias; every VALUE-position use (`new
 * Prisma.Decimal(...)`, `Prisma.Decimal.isDecimal(...)`) still reads
 * `Prisma.Decimal` directly.
 */
type Decimal = InstanceType<typeof Prisma.Decimal>;

/**
 * Invoice System Slice 1 — bounded invoice currency contract
 * (docs/invoicing-architecture.md §6). Deliberately narrower than
 * OrganizationProfile's own currency support (which accepts every
 * `Intl.supportedValuesOf("currency")` value, src/lib/validation/
 * company-profile.ts:31) — this app's `Decimal(10,2)` money columns
 * structurally assume exactly 2 decimal places everywhere, so a
 * zero-decimal currency (e.g. JPY) or three-decimal currency (e.g. BHD,
 * KWD) is out of scope for invoice creation, not silently truncated.
 * OrganizationProfile's own broader currency support is untouched by this
 * module.
 */

const REFERENCE_LOCALE = "en-US";

function resolvesToTwoDecimalPlaces(currency: string): boolean {
  try {
    const options = new Intl.NumberFormat(REFERENCE_LOCALE, { style: "currency", currency }).resolvedOptions();
    return options.minimumFractionDigits === 2 && options.maximumFractionDigits === 2;
  } catch {
    // Intl throws a RangeError for a syntactically invalid currency code
    // (not merely an unusual one) — never a currency this app should
    // consider supported.
    return false;
  }
}

// Built from Intl.supportedValuesOf("currency") — the same real-platform-API
// technique already proven in src/lib/validation/company-profile.ts:31 —
// filtered down to exactly the two-decimal-place subset (§6). Computed once
// at module load; Intl's own currency table doesn't change at runtime.
const SUPPORTED_INVOICE_CURRENCIES: ReadonlySet<string> = new Set(
  Intl.supportedValuesOf("currency").filter(resolvesToTwoDecimalPlaces),
);

/** Uppercase-normalizes and checks membership in the bounded two-decimal-place set — never "any 3 uppercase letters." */
export function isSupportedInvoiceCurrency(value: string): boolean {
  return SUPPORTED_INVOICE_CURRENCIES.has(value.trim().toUpperCase());
}

/** Every supported invoice currency code, sorted ascending — a stable order for rendering a `<select>`. */
export function getSupportedInvoiceCurrencies(): readonly string[] {
  return Array.from(SUPPORTED_INVOICE_CURRENCIES).sort();
}

export type InvoiceCurrencyDefault = {
  /** The currency a new invoice's form should default to. */
  currency: string;
  /** True when `organizationCurrency` was missing/unsupported and `currency` fell back to USD instead. */
  isFallback: boolean;
  /** The organization's own currency as read, uppercase-normalized — null if absent/blank. Present even when it caused a fallback, so the UI can say what was rejected. */
  organizationCurrency: string | null;
};

/**
 * Resolves the default currency for a new invoice form (§6): the
 * organization's own currency when it's in the supported two-decimal set,
 * else an explicit USD fallback — never a silent substitution the caller
 * can't detect and disclose.
 */
export function resolveInvoiceCurrencyDefault(organizationCurrency: string | null | undefined): InvoiceCurrencyDefault {
  const normalized = organizationCurrency?.trim().toUpperCase() || null;

  if (normalized && isSupportedInvoiceCurrency(normalized)) {
    return { currency: normalized, isFallback: false, organizationCurrency: normalized };
  }

  return { currency: "USD", isFallback: true, organizationCurrency: normalized };
}

export type CurrencyAmountInput = Decimal | string | number;

// Decimal(10,2) ceiling — mirrors src/lib/invoices/calculations.ts's own
// MONEY_MAX/precision boundary exactly (this app's invoice money columns
// are all Decimal(10,2)). Duplicated here rather than imported, so this
// module's own Decimal boundary stays self-contained and independently
// testable, matching this codebase's own stated per-module-copy
// convention (see currencies.ts's own header comment on
// Intl.supportedValuesOf reuse).
const MONEY_MAX = new Prisma.Decimal("99999999.99");
const MONEY_DECIMAL_PLACES = 2;

// Accepts only plain, non-exponential decimal syntax: an optional leading
// minus sign, at least one integer digit, and an optional fractional
// part. Deliberately stricter than a bare `new Prisma.Decimal(x)` call,
// which otherwise happily parses hex ("0x10" -> 16), exponential
// notation ("1e2" -> 100), and the literal words "Infinity"/"NaN" as
// valid decimals — none of which is a legitimate invoice-amount string.
const STRICT_DECIMAL_STRING_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * Parses and validates a monetary amount against the exact Decimal(10,2)
 * boundary every invoice money column uses — never a bare `Number()`
 * conversion, which would accept a blank string as `0`, silently drop
 * precision, or let a value outside the column's real range through.
 * Returns `null` for anything that isn't a non-negative, at-most-2-
 * decimal-place value no greater than 99,999,999.99.
 */
function parseMoneyDecimal(input: CurrencyAmountInput): Decimal | null {
  let decimal: Decimal;

  // Prisma.Decimal.isDecimal(), not `instanceof` — this module imports
  // Prisma.Decimal from `@/generated/prisma/browser` (required for Client
  // Component bundling), but a caller may hold a Decimal constructed via
  // `@/generated/prisma/client` (still used by Server Action code
  // elsewhere in this app). Empirically verified (throwaway Vitest spec,
  // not assumed) that under this repo's actual Vitest module resolution
  // these are NOT the same class reference, so `instanceof` silently
  // rejects a perfectly valid Decimal from the other entry point.
  // `Decimal.isDecimal()` is decimal.js's own duck-typing cross-instance
  // check, built exactly for this scenario — see the identical, longer
  // comment on `toDecimal()` in src/lib/invoices/calculations.ts.
  if (Prisma.Decimal.isDecimal(input)) {
    decimal = input;
  } else if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    decimal = new Prisma.Decimal(input);
  } else {
    const trimmed = input.trim();
    if (!STRICT_DECIMAL_STRING_PATTERN.test(trimmed)) return null;
    try {
      decimal = new Prisma.Decimal(trimmed);
    } catch {
      return null;
    }
  }

  if (!decimal.isFinite()) return null;
  if (decimal.isNegative()) return null;
  if (decimal.decimalPlaces() > MONEY_DECIMAL_PLACES) return null;
  if (decimal.greaterThan(MONEY_MAX)) return null;

  return decimal;
}

/**
 * Formats a monetary amount for a supported invoice currency. Validates
 * the currency AND parses/validates `amount` through `Prisma.Decimal`
 * against the exact Decimal(10,2) boundary (see `parseMoneyDecimal`)
 * BEFORE ever calling `Intl.NumberFormat` — never throws for rejected
 * input, returns `null` instead, so a caller can't accidentally crash a
 * render path on a bad currency/amount, and can't have a blank or
 * malformed value silently rendered as `$0.00`.
 */
export function formatInvoiceCurrencyAmount(
  amount: CurrencyAmountInput,
  currency: string,
  locale: string = REFERENCE_LOCALE,
): string | null {
  if (!isSupportedInvoiceCurrency(currency)) return null;

  const decimal = parseMoneyDecimal(amount);
  if (decimal === null) return null;

  // Only convert to a JS `number` here, at the final Intl.NumberFormat
  // presentation boundary — never earlier, and never used for any
  // validation, calculation, comparison, or persistence (every financial
  // calculation and every persisted value stays `Prisma.Decimal`
  // end to end). This conversion is a binary floating-point
  // approximation, not an exact representation of the decimal value —
  // most Decimal(10,2) values, including the ceiling 99,999,999.99, have
  // no exact binary64 representation. It's display-safe here only
  // because `decimal` has already been validated as non-negative,
  // Decimal(10,2), and no greater than 99,999,999.99: within that bounded
  // range, the binary64 representation error is far smaller than half a
  // cent, so Intl.NumberFormat — rendering with exactly two fraction
  // digits for this supported invoice currency — always displays the
  // correct rounded amount.
  return new Intl.NumberFormat(locale, { style: "currency", currency: currency.trim().toUpperCase() }).format(
    decimal.toNumber(),
  );
}
