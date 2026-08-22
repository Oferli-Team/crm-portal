import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Correction — Invoice System Slice 4 post-deploy fix, consistency pass.
 * InvoiceForm's own "Add line" button used the same raw color-override
 * className pattern that produced a reproduced production defect
 * (invisible white-on-white button text) on InvoiceIssueControls/
 * InvoiceSendControls — see button-variant-contract.test.ts for the
 * shared Button component's own contract. No DOM/component-rendering
 * harness exists in this repo (see invoice-issue-controls-contract
 * .test.ts's own header comment), so this is a source-contract proxy,
 * same as every other component test here, plus a real computed-style
 * E2E proof (test/e2e/invoices.spec.ts).
 */

const source = readFileSync("src/components/invoices/invoice-form.tsx", "utf-8");

it('the "Add line" Button uses variant="secondary", never a raw bg-*/text-* override className', () => {
  // Non-greedy [\s\S]*?> alone would truncate at the first ">" met — this
  // tag has none inside an arrow function, but the shared regex form is
  // kept identical to the other corrected call sites' own tests.
  const buttonMatch = source.match(/<Button\b(?:=>|[^>])*>\s*Add line/);
  expect(buttonMatch).not.toBeNull();
  expect(buttonMatch![0]).toContain('variant="secondary"');
  const classNameMatch = buttonMatch![0].match(/className="([^"]*)"/);
  // The button keeps its spacing-only "mt-3" className — this must remain,
  // proving the fix did not silently drop the intended layout.
  expect(classNameMatch?.[1]).toBe("mt-3");
  const COLOR_UTILITY_PATTERN = /^(bg|text)-(black|white|transparent|current|inherit|[a-z]+-\d{2,3})$/;
  const colorUtilities = (classNameMatch?.[1] ?? "").split(/\s+/).filter((cls) => COLOR_UTILITY_PATTERN.test(cls));
  expect(colorUtilities).toEqual([]);
});

it('the button always renders the non-empty literal label "Add line"', () => {
  expect(source).toMatch(/>\s*Add line\s*</);
});

describe("InvoiceForm — Add line Button", () => {
  it("still calls addLineItem on click — behavior unchanged by the variant correction", () => {
    expect(source).toContain("onClick={addLineItem}");
  });
});
