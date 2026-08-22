import { describe, expect, it } from "vitest";
import {
  ALLOWED_STATUS_TRANSITIONS,
  isTransitionAllowed,
  computePaidAtUpdate,
} from "@/lib/invoices/lifecycle";
import type { InvoiceStatus } from "@/generated/prisma/browser";

const ALL_STATUSES: InvoiceStatus[] = ["DRAFT", "SENT", "PAID", "OVERDUE", "CANCELLED"];

// The exact transition matrix from docs/invoicing-architecture.md §3.1,
// expressed as the full 5x5 truth table so every cell — not just the
// "interesting" ones — is exercised explicitly.
const EXPECTED: Record<InvoiceStatus, Record<InvoiceStatus, boolean>> = {
  DRAFT: { DRAFT: false, SENT: false, PAID: false, OVERDUE: false, CANCELLED: false },
  SENT: { DRAFT: false, SENT: false, PAID: true, OVERDUE: true, CANCELLED: true },
  OVERDUE: { DRAFT: false, SENT: true, PAID: true, OVERDUE: false, CANCELLED: true },
  PAID: { DRAFT: false, SENT: true, PAID: false, OVERDUE: false, CANCELLED: false },
  CANCELLED: { DRAFT: false, SENT: false, PAID: false, OVERDUE: false, CANCELLED: false },
};

describe("ALLOWED_STATUS_TRANSITIONS / isTransitionAllowed — full 5x5 matrix", () => {
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      const expected = EXPECTED[from][to];
      it(`${from} -> ${to} is ${expected ? "allowed" : "forbidden"}`, () => {
        expect(isTransitionAllowed(from, to)).toBe(expected);
      });
    }
  }

  it("DRAFT and CANCELLED both allow no transitions at all", () => {
    expect(ALLOWED_STATUS_TRANSITIONS.DRAFT).toEqual([]);
    expect(ALLOWED_STATUS_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it("matches the exact matrix given in the task/design report", () => {
    expect(ALLOWED_STATUS_TRANSITIONS.SENT).toEqual(["PAID", "OVERDUE", "CANCELLED"]);
    expect(ALLOWED_STATUS_TRANSITIONS.OVERDUE).toEqual(["PAID", "SENT", "CANCELLED"]);
    expect(ALLOWED_STATUS_TRANSITIONS.PAID).toEqual(["SENT"]);
  });

  it("ALLOWED_STATUS_TRANSITIONS is frozen — reassigning a row throws in strict mode", () => {
    expect(Object.isFrozen(ALLOWED_STATUS_TRANSITIONS)).toBe(true);
    expect(() => {
      // @ts-expect-error — intentionally violating the readonly type to prove runtime immutability too.
      ALLOWED_STATUS_TRANSITIONS.SENT = [];
    }).toThrow();
  });

  it("does not mutate ALLOWED_STATUS_TRANSITIONS across repeated calls", () => {
    const before = JSON.parse(JSON.stringify(ALLOWED_STATUS_TRANSITIONS));
    isTransitionAllowed("SENT", "PAID");
    isTransitionAllowed("DRAFT", "SENT");
    isTransitionAllowed("CANCELLED", "CANCELLED");
    expect(JSON.parse(JSON.stringify(ALLOWED_STATUS_TRANSITIONS))).toEqual(before);
  });
});

describe("computePaidAtUpdate — exact 4-case rule, deterministic (no internal Date.now/new Date)", () => {
  const now = new Date("2026-08-16T12:00:00.000Z");

  it("not-paid -> paid: stamps the injected now", () => {
    const result = computePaidAtUpdate(false, true, now);
    expect(result).toEqual({ paidAt: now });
    expect(result.paidAt).toBe(now); // same reference — never internally constructs its own Date
  });

  it("paid -> not-paid: clears to null", () => {
    const result = computePaidAtUpdate(true, false, now);
    expect(result).toEqual({ paidAt: null });
    expect(result.paidAt).toBeNull();
  });

  it("paid -> paid: omits the key entirely (not just paidAt: undefined)", () => {
    const result = computePaidAtUpdate(true, true, now);
    expect(result).toEqual({});
    expect("paidAt" in result).toBe(false);
  });

  it("not-paid -> not-paid: omits the key entirely", () => {
    const result = computePaidAtUpdate(false, false, now);
    expect(result).toEqual({});
    expect("paidAt" in result).toBe(false);
  });

  it("never mutates the injected now Date", () => {
    const mutableCheck = new Date("2026-01-01T00:00:00.000Z");
    const beforeTime = mutableCheck.getTime();
    computePaidAtUpdate(false, true, mutableCheck);
    computePaidAtUpdate(true, false, mutableCheck);
    expect(mutableCheck.getTime()).toBe(beforeTime);
  });

  it("is a pure function of its arguments — identical inputs always produce an equivalent result", () => {
    const a = computePaidAtUpdate(false, true, now);
    const b = computePaidAtUpdate(false, true, now);
    expect(a).toEqual(b);
  });
});
