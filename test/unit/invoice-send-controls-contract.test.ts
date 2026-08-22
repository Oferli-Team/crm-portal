import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/components/invoices/invoice-send-controls.tsx", "utf8");

describe("InvoiceSendControls source contract", () => {
  it("uses a real random UUID, never useId, for each logical attempt", () => {
    expect(source).toContain("crypto.randomUUID()");
    expect(source).not.toContain("useId(");
  });

  it("catches rejected Server Action calls without exposing the thrown value", () => {
    expect(source).toContain("await sendInvoiceEmailAction(");
    expect(source).toMatch(/}\s*catch\s*{/);
    expect(source).not.toMatch(/catch\s*\([^)]/);
  });

  it("requires explicit warning copy before resending after UNKNOWN", () => {
    expect(source).toContain("may already have been accepted");
    expect(source).toContain("Resend anyway");
    expect(source).toContain("acknowledgeUnknownId");
  });

  // Correction — Invoice System Slice 4 post-deploy fix. See
  // button-variant-contract.test.ts and invoice-issue-controls-contract
  // .test.ts's own identical addition for the full explanation: a raw
  // color-utility override className on this shared Button component
  // reproduced genuinely invisible white-on-white button text in
  // production.
  it("the Send/Issue & Send Button uses variant=\"secondary\", never a raw bg-*/text-* override className", () => {
    expect(source).toContain('variant="secondary"');
    const buttonMatch = source.match(/<Button[\s\S]*?>/);
    expect(buttonMatch).not.toBeNull();
    const classNameMatch = buttonMatch![0].match(/className="([^"]*)"/);
    // Matches a genuine Tailwind color utility (bg-black, text-gray-900,
    // ...) — excludes non-color text-* utilities (text-sm, text-center, ...).
    const COLOR_UTILITY_PATTERN = /^(bg|text)-(black|white|transparent|current|inherit|[a-z]+-\d{2,3})$/;
    const colorUtilities = (classNameMatch?.[1] ?? "").split(/\s+/).filter((cls) => COLOR_UTILITY_PATTERN.test(cls));
    expect(colorUtilities).toEqual([]);
  });

  it("the button always renders a non-empty label — Issue & Send, Send invoice, or Resend invoice, never blank", () => {
    expect(source).toContain('"Issue & Send"');
    expect(source).toContain('"Resend invoice"');
    expect(source).toContain('"Send invoice"');
  });
});
