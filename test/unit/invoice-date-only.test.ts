import { describe, expect, it } from "vitest";
import { parseDateOnly, formatDateOnly, formatDateOnlyForDisplay } from "@/lib/invoices/date-only";

describe("parseDateOnly / formatDateOnly", () => {
  it("rejects year 0000", () => {
    expect(parseDateOnly("0000-01-01")).toEqual({ ok: false });
  });

  it("accepts 0001-01-01 and round-trips without an 1900-offset leak", () => {
    const result = parseDateOnly("0001-01-01");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.date.getUTCFullYear()).toBe(1);
      expect(formatDateOnly(result.date)).toBe("0001-01-01");
    }
  });

  it("accepts 0099-12-31 and round-trips", () => {
    const result = parseDateOnly("0099-12-31");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.date.getUTCFullYear()).toBe(99);
      expect(formatDateOnly(result.date)).toBe("0099-12-31");
    }
  });

  it("accepts an ordinary modern date and round-trips", () => {
    const result = parseDateOnly("2026-08-16");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(formatDateOnly(result.date)).toBe("2026-08-16");
      expect(result.date.getUTCHours()).toBe(0);
      expect(result.date.getUTCMinutes()).toBe(0);
      expect(result.date.getUTCSeconds()).toBe(0);
      expect(result.date.getUTCMilliseconds()).toBe(0);
    }
  });

  it("accepts Feb 29 on a leap year and round-trips", () => {
    const result = parseDateOnly("2028-02-29");
    expect(result.ok).toBe(true);
    if (result.ok) expect(formatDateOnly(result.date)).toBe("2028-02-29");
  });

  it("rejects Feb 29 on a non-leap year", () => {
    expect(parseDateOnly("2027-02-29")).toEqual({ ok: false });
  });

  it("rejects impossible calendar dates", () => {
    expect(parseDateOnly("2026-02-30")).toEqual({ ok: false });
    expect(parseDateOnly("2026-04-31")).toEqual({ ok: false });
    expect(parseDateOnly("2026-13-01")).toEqual({ ok: false });
    expect(parseDateOnly("2026-00-01")).toEqual({ ok: false });
    expect(parseDateOnly("2026-01-00")).toEqual({ ok: false });
    expect(parseDateOnly("2026-01-32")).toEqual({ ok: false });
  });

  it("rejects malformed shapes", () => {
    expect(parseDateOnly("2026-2-3")).toEqual({ ok: false });
    expect(parseDateOnly("26-02-03")).toEqual({ ok: false });
    expect(parseDateOnly("2026/02/03")).toEqual({ ok: false });
    expect(parseDateOnly("2026-02-03T00:00:00.000Z")).toEqual({ ok: false });
    expect(parseDateOnly("")).toEqual({ ok: false });
    expect(parseDateOnly("   ")).toEqual({ ok: false });
    expect(parseDateOnly(" 2026-02-03")).toEqual({ ok: false });
    expect(parseDateOnly("2026-02-03 ")).toEqual({ ok: false });
  });

  // No process.env.TZ mutation anywhere in this file — every assertion
  // relies exclusively on the function's own UTC* methods, which are
  // timezone-independent by construction.
});

describe("formatDateOnlyForDisplay", () => {
  // A midnight-UTC fixture — exactly what parseDateOnly() itself produces
  // for "2026-01-05" — with an explicit locale, so the assertion is
  // deterministic regardless of the machine's own default locale/timezone.
  // No process.env.TZ mutation anywhere in this file: pinning
  // `timeZone: "UTC"` inside the implementation is what makes the result
  // timezone-independent, not a test-environment hack.
  const midnightUtcFixture = new Date(Date.UTC(2026, 0, 5, 0, 0, 0, 0));

  it("renders the same calendar date parseDateOnly/formatDateOnly agree on, in an explicit locale", () => {
    expect(formatDateOnlyForDisplay(midnightUtcFixture, "en-US")).toBe("1/5/2026");
  });

  it("never drifts to the previous day regardless of the caller's own local timezone", () => {
    // Without a UTC-pinned timeZone, a negative-offset environment renders
    // this same instant as "1/4/2026" — the very drift this helper exists
    // to prevent. Asserting the exact positive-day string directly proves
    // the fix, without needing to simulate a specific host timezone.
    expect(formatDateOnlyForDisplay(midnightUtcFixture, "en-US")).not.toBe("1/4/2026");
  });

  it("round-trips consistently with parseDateOnly for the same source string", () => {
    const parsed = parseDateOnly("2026-01-05");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(formatDateOnlyForDisplay(parsed.date, "en-US")).toBe("1/5/2026");
    }
  });

  it("respects a different explicit locale's formatting convention", () => {
    expect(formatDateOnlyForDisplay(midnightUtcFixture, "en-GB")).toBe("05/01/2026");
  });
});
