import { describe, expect, it } from "vitest";
import { buildInvoiceEmailContent, type InvoiceEmailViewModelInput } from "@/lib/invoices/email/view-model";

const DUE_DATE = new Date(0);
DUE_DATE.setUTCFullYear(2026, 0, 5); // 2026-01-05, per parseDateOnly()'s own UTC-midnight contract

const BASE_INPUT: InvoiceEmailViewModelInput = {
  invoiceNumber: "INV-2026-001",
  recipientDisplayName: "Acme Corp",
  issuerDisplayName: "Freelance Studio LLC",
  totalAmount: "1234.50",
  currency: "USD",
  dueDate: DUE_DATE,
  locale: "en-US",
};

describe("buildInvoiceEmailContent — deterministic content", () => {
  it("is deterministic for the same input", () => {
    const first = buildInvoiceEmailContent(BASE_INPUT);
    const second = buildInvoiceEmailContent(BASE_INPUT);
    expect(first).toEqual(second);
  });

  it("builds the exact subject", () => {
    const result = buildInvoiceEmailContent(BASE_INPUT);
    expect(result.subject).toBe("Invoice INV-2026-001 from Freelance Studio LLC");
  });

  it("formats the total via the existing currency formatter (en-US)", () => {
    const result = buildInvoiceEmailContent(BASE_INPUT);
    expect(result.html).toContain("$1,234.50");
    expect(result.text).toContain("$1,234.50");
  });

  it("formats the due date via the existing date-only display formatter (en-US)", () => {
    const result = buildInvoiceEmailContent(BASE_INPUT);
    expect(result.html).toContain("1/5/2026");
    expect(result.text).toContain("1/5/2026");
  });

  it("omits the due-date clause when the Invoice has no due date", () => {
    const result = buildInvoiceEmailContent({ ...BASE_INPUT, dueDate: null });
    expect(result.html).not.toContain(", due ");
    expect(result.text).not.toContain(", due ");
    expect(result.html).toContain("The invoice is attached");
  });

  it("includes the invoice number and issuer/recipient display names in both html and text", () => {
    const result = buildInvoiceEmailContent(BASE_INPUT);
    for (const value of ["INV-2026-001", "Acme Corp", "Freelance Studio LLC"]) {
      expect(result.html).toContain(value);
      expect(result.text).toContain(value);
    }
  });

  it("never claims the email was delivered — only issued/attached", () => {
    const result = buildInvoiceEmailContent(BASE_INPUT);
    expect(result.html.toLowerCase()).not.toContain("delivered");
    expect(result.text.toLowerCase()).not.toContain("delivered");
  });
});

describe("buildInvoiceEmailContent — HTML escaping", () => {
  it("escapes an HTML-significant recipientDisplayName", () => {
    const result = buildInvoiceEmailContent({ ...BASE_INPUT, recipientDisplayName: `<script>alert("x")</script>` });
    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain("&lt;script&gt;");
  });

  it("escapes an HTML-significant issuerDisplayName", () => {
    const result = buildInvoiceEmailContent({ ...BASE_INPUT, issuerDisplayName: `Bob's "Best" Invoices & Co` });
    expect(result.html).toContain("Bob&#39;s &quot;Best&quot; Invoices &amp; Co");
    expect(result.html).not.toContain(`Bob's "Best" Invoices & Co`);
  });

  it("escapes an HTML-significant invoiceNumber", () => {
    const result = buildInvoiceEmailContent({ ...BASE_INPUT, invoiceNumber: `INV<1>` });
    expect(result.html).toContain("INV&lt;1&gt;");
    expect(result.html).not.toContain("INV<1>");
  });

  it("escapes quotes inside the portalInvoiceUrl href attribute", () => {
    const result = buildInvoiceEmailContent({
      ...BASE_INPUT,
      portalInvoiceUrl: `https://app.example.com/portal/invoices/1?x="onmouseover=alert(1)`,
    });
    expect(result.html).not.toContain(`x="onmouseover=alert(1)"`);
    expect(result.html).toContain("&quot;onmouseover=alert(1)");
  });

  it("escapes an ampersand in the portalInvoiceUrl", () => {
    const result = buildInvoiceEmailContent({ ...BASE_INPUT, portalInvoiceUrl: "https://app.example.com/portal?a=1&b=2" });
    expect(result.html).toContain("https://app.example.com/portal?a=1&amp;b=2");
  });
});

describe("buildInvoiceEmailContent — plain text stays plain", () => {
  it("never substitutes HTML entities for the equivalent character in text", () => {
    const result = buildInvoiceEmailContent({ ...BASE_INPUT, recipientDisplayName: `Bob's "Best" Invoices & Co` });
    expect(result.text).toContain(`Bob's "Best" Invoices & Co`);
    expect(result.text).not.toContain("&#39;");
    expect(result.text).not.toContain("&quot;");
    expect(result.text).not.toContain("&amp;");
  });

  it("has no HTML tags at all", () => {
    const result = buildInvoiceEmailContent(BASE_INPUT);
    expect(result.text).not.toMatch(/<[a-z][\s\S]*>/i);
  });
});

describe("buildInvoiceEmailContent — Portal Invoice URL presence/absence", () => {
  it("includes a 'View invoice' link and text-mode URL when portalInvoiceUrl is supplied", () => {
    const result = buildInvoiceEmailContent({ ...BASE_INPUT, portalInvoiceUrl: "https://app.example.com/portal/invoices/1" });
    expect(result.html).toContain("View invoice");
    expect(result.html).toContain("https://app.example.com/portal/invoices/1");
    expect(result.text).toContain("View invoice: https://app.example.com/portal/invoices/1");
  });

  it("omits any invoice link when portalInvoiceUrl is undefined", () => {
    const result = buildInvoiceEmailContent(BASE_INPUT);
    expect(result.html).not.toContain("View invoice");
    expect(result.text).not.toContain("View invoice");
  });

  it("omits any invoice link when portalInvoiceUrl is explicitly null", () => {
    const result = buildInvoiceEmailContent({ ...BASE_INPUT, portalInvoiceUrl: null });
    expect(result.html).not.toContain("View invoice");
    expect(result.text).not.toContain("View invoice");
  });
});

describe("buildInvoiceEmailContent — bounded input, no internal data ever present", () => {
  it("InvoiceEmailViewModelInput has no internalNotes field — structurally impossible, not merely unused", () => {
    // @ts-expect-error — internalNotes is not a key of InvoiceEmailViewModelInput.
    const bad: InvoiceEmailViewModelInput = { ...BASE_INPUT, internalNotes: "should never compile" };
    void bad;
  });

  it("the rendered output never contains a provider message id, storage path, or secret-shaped value", () => {
    const result = buildInvoiceEmailContent({ ...BASE_INPUT, portalInvoiceUrl: "https://app.example.com/portal/invoices/1" });
    const combined = `${result.subject}\n${result.html}\n${result.text}`;
    for (const forbidden of ["re_", "storage/v1", "SUPABASE_SERVICE_ROLE_KEY", "signedUrl", "access_token"]) {
      expect(combined).not.toContain(forbidden);
    }
  });
});
