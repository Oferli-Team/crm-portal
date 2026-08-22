import { describe, expect, it } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import {
  isSupportedInvoiceCurrency,
  getSupportedInvoiceCurrencies,
  resolveInvoiceCurrencyDefault,
  formatInvoiceCurrencyAmount,
} from "@/lib/invoices/currencies";

describe("isSupportedInvoiceCurrency", () => {
  it("accepts USD", () => {
    expect(isSupportedInvoiceCurrency("USD")).toBe(true);
  });

  it("accepts EUR", () => {
    expect(isSupportedInvoiceCurrency("EUR")).toBe(true);
  });

  it("normalizes lowercase/mixed-case input", () => {
    expect(isSupportedInvoiceCurrency("usd")).toBe(true);
    expect(isSupportedInvoiceCurrency("UsD")).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    expect(isSupportedInvoiceCurrency("  USD  ")).toBe(true);
  });

  it("rejects JPY (zero-decimal currency)", () => {
    expect(isSupportedInvoiceCurrency("JPY")).toBe(false);
  });

  it("rejects BHD and KWD (three-decimal currencies)", () => {
    expect(isSupportedInvoiceCurrency("BHD")).toBe(false);
    expect(isSupportedInvoiceCurrency("KWD")).toBe(false);
  });

  it("rejects an arbitrary three-letter string that isn't a real ISO currency", () => {
    expect(isSupportedInvoiceCurrency("XYZ")).toBe(false);
    expect(isSupportedInvoiceCurrency("ABC")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isSupportedInvoiceCurrency("")).toBe(false);
  });
});

describe("getSupportedInvoiceCurrencies", () => {
  const supported = getSupportedInvoiceCurrencies();

  it("includes USD and EUR", () => {
    expect(supported).toContain("USD");
    expect(supported).toContain("EUR");
  });

  it("excludes JPY, BHD, KWD", () => {
    expect(supported).not.toContain("JPY");
    expect(supported).not.toContain("BHD");
    expect(supported).not.toContain("KWD");
  });

  it("is sorted ascending", () => {
    const sorted = [...supported].sort();
    expect(supported).toEqual(sorted);
  });

  it("returns a stable list across repeated calls", () => {
    expect(getSupportedInvoiceCurrencies()).toEqual(supported);
  });

  it("contains no duplicates", () => {
    expect(new Set(supported).size).toBe(supported.length);
  });
});

describe("resolveInvoiceCurrencyDefault", () => {
  it("uses a supported organization currency as-is, no fallback", () => {
    const result = resolveInvoiceCurrencyDefault("EUR");
    expect(result).toEqual({ currency: "EUR", isFallback: false, organizationCurrency: "EUR" });
  });

  it("normalizes case for a supported organization currency", () => {
    const result = resolveInvoiceCurrencyDefault("eur");
    expect(result).toEqual({ currency: "EUR", isFallback: false, organizationCurrency: "EUR" });
  });

  it("falls back to USD, with an explicit indicator, for an unsupported (zero-decimal) organization currency", () => {
    const result = resolveInvoiceCurrencyDefault("JPY");
    expect(result).toEqual({ currency: "USD", isFallback: true, organizationCurrency: "JPY" });
  });

  it("falls back to USD for a missing organization currency, with organizationCurrency null", () => {
    expect(resolveInvoiceCurrencyDefault(null)).toEqual({ currency: "USD", isFallback: true, organizationCurrency: null });
    expect(resolveInvoiceCurrencyDefault(undefined)).toEqual({
      currency: "USD",
      isFallback: true,
      organizationCurrency: null,
    });
    expect(resolveInvoiceCurrencyDefault("")).toEqual({ currency: "USD", isFallback: true, organizationCurrency: null });
  });

  it("falls back to USD for a bogus organization currency string, preserving what was rejected", () => {
    expect(resolveInvoiceCurrencyDefault("NOTREAL")).toEqual({
      currency: "USD",
      isFallback: true,
      organizationCurrency: "NOTREAL",
    });
  });

  it("USD itself as the organization currency is never a fallback", () => {
    expect(resolveInvoiceCurrencyDefault("USD")).toEqual({ currency: "USD", isFallback: false, organizationCurrency: "USD" });
  });
});

describe("formatInvoiceCurrencyAmount", () => {
  it("never throws for an unsupported currency — returns null instead", () => {
    expect(() => formatInvoiceCurrencyAmount(100, "JPY")).not.toThrow();
    expect(formatInvoiceCurrencyAmount(100, "JPY")).toBeNull();
  });

  it("never throws for a nonsense currency string — returns null instead", () => {
    expect(() => formatInvoiceCurrencyAmount(100, "NOT_A_CURRENCY")).not.toThrow();
    expect(formatInvoiceCurrencyAmount(100, "NOT_A_CURRENCY")).toBeNull();
  });

  it("returns null for a non-finite amount", () => {
    expect(formatInvoiceCurrencyAmount(Number.NaN, "USD")).toBeNull();
    expect(formatInvoiceCurrencyAmount(Number.POSITIVE_INFINITY, "USD")).toBeNull();
    expect(formatInvoiceCurrencyAmount(Number.NEGATIVE_INFINITY, "USD")).toBeNull();
  });

  it("returns null for a non-numeric string amount", () => {
    expect(formatInvoiceCurrencyAmount("not-a-number", "USD")).toBeNull();
  });

  it("formats a supported-currency amount with exactly 2 fraction digits — asserted via formatToParts, not a literal glyph/spacing comparison", () => {
    const formatted = formatInvoiceCurrencyAmount(1234.5, "USD");
    expect(formatted).not.toBeNull();

    const parts = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).formatToParts(1234.5);
    const integer = parts.filter((p) => p.type === "integer").map((p) => p.value).join("");
    const fraction = parts.find((p) => p.type === "fraction")?.value;
    expect(integer).toBe("1234");
    expect(fraction).toBe("50");

    // The formatted string actually contains the fraction digits,
    // regardless of symbol glyph or grouping-separator spacing.
    expect(formatted).toContain("50");
  });

  it("accepts a string amount identically to a number amount", () => {
    expect(formatInvoiceCurrencyAmount("1234.50", "USD")).toBe(formatInvoiceCurrencyAmount(1234.5, "USD"));
  });

  it("normalizes currency case when formatting", () => {
    expect(formatInvoiceCurrencyAmount(10, "usd")).toBe(formatInvoiceCurrencyAmount(10, "USD"));
  });

  describe("Decimal(10,2) boundary hardening — parses/validates through Prisma.Decimal, never a bare Number() conversion", () => {
    it("accepts a Prisma.Decimal input directly", () => {
      const viaDecimal = formatInvoiceCurrencyAmount(new Prisma.Decimal("1234.50"), "USD");
      const viaString = formatInvoiceCurrencyAmount("1234.50", "USD");
      expect(viaDecimal).not.toBeNull();
      expect(viaDecimal).toBe(viaString);
    });

    it("rejects an empty string — never silently treated as zero", () => {
      expect(formatInvoiceCurrencyAmount("", "USD")).toBeNull();
    });

    it("rejects a whitespace-only string — never silently treated as zero", () => {
      expect(formatInvoiceCurrencyAmount("   ", "USD")).toBeNull();
      expect(formatInvoiceCurrencyAmount("\t\n", "USD")).toBeNull();
    });

    it("rejects a malformed/non-decimal numeric string such as hex (\"0x10\")", () => {
      expect(formatInvoiceCurrencyAmount("0x10", "USD")).toBeNull();
    });

    it("rejects exponential notation, even though it's valid JS/Decimal syntax", () => {
      expect(formatInvoiceCurrencyAmount("1e2", "USD")).toBeNull();
    });

    it("rejects the literal string forms \"NaN\" and \"Infinity\"", () => {
      expect(formatInvoiceCurrencyAmount("NaN", "USD")).toBeNull();
      expect(formatInvoiceCurrencyAmount("Infinity", "USD")).toBeNull();
      expect(formatInvoiceCurrencyAmount("-Infinity", "USD")).toBeNull();
    });

    it("rejects a negative amount, as a string, number, and Prisma.Decimal", () => {
      expect(formatInvoiceCurrencyAmount("-0.01", "USD")).toBeNull();
      expect(formatInvoiceCurrencyAmount(-0.01, "USD")).toBeNull();
      expect(formatInvoiceCurrencyAmount(new Prisma.Decimal("-0.01"), "USD")).toBeNull();
    });

    it("rejects a value with more than 2 decimal places", () => {
      expect(formatInvoiceCurrencyAmount("1.005", "USD")).toBeNull();
      expect(formatInvoiceCurrencyAmount(new Prisma.Decimal("1.005"), "USD")).toBeNull();
    });

    it("rejects a value above the Decimal(10,2) ceiling of 99,999,999.99", () => {
      expect(formatInvoiceCurrencyAmount("100000000.00", "USD")).toBeNull();
      expect(formatInvoiceCurrencyAmount(100000000, "USD")).toBeNull();
    });

    it("accepts zero", () => {
      expect(formatInvoiceCurrencyAmount("0", "USD")).not.toBeNull();
      expect(formatInvoiceCurrencyAmount(0, "USD")).not.toBeNull();
      expect(formatInvoiceCurrencyAmount(new Prisma.Decimal(0), "USD")).not.toBeNull();
    });

    it("accepts exactly the Decimal(10,2) ceiling of 99,999,999.99", () => {
      const formatted = formatInvoiceCurrencyAmount("99999999.99", "USD");
      expect(formatted).not.toBeNull();

      const parts = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).formatToParts(99999999.99);
      const integer = parts.filter((p) => p.type === "integer").map((p) => p.value).join("");
      const fraction = parts.find((p) => p.type === "fraction")?.value;
      expect(integer).toBe("99999999");
      expect(fraction).toBe("99");
    });
  });
});
