import { describe, expect, it } from "vitest";
import { formatInvoiceStatusLabel } from "@/lib/invoices/status-label";

describe("formatInvoiceStatusLabel", () => {
  it("SENT renders as Issued", () => {
    expect(formatInvoiceStatusLabel("SENT")).toBe("Issued");
  });

  it("every other InvoiceStatus falls back to the generic formatter", () => {
    expect(formatInvoiceStatusLabel("DRAFT")).toBe("Draft");
    expect(formatInvoiceStatusLabel("PAID")).toBe("Paid");
    expect(formatInvoiceStatusLabel("OVERDUE")).toBe("Overdue");
    expect(formatInvoiceStatusLabel("CANCELLED")).toBe("Cancelled");
  });

  it("an unrelated status value is unaffected (no accidental collision)", () => {
    expect(formatInvoiceStatusLabel("IN_PROGRESS")).toBe("In Progress");
  });
});
