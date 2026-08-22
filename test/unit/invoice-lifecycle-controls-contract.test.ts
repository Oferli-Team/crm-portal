import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Correction — Invoice System Slice 4 post-deploy fix, consistency pass.
 * InvoiceLifecycleControls' own transition buttons and Cancel button used
 * the same raw color-override className pattern that produced a
 * reproduced production defect (invisible white-on-white button text) on
 * InvoiceIssueControls/InvoiceSendControls — see button-variant-contract
 * .test.ts for the shared Button component's own contract. No DOM/
 * component-rendering harness exists in this repo (see
 * invoice-issue-controls-contract.test.ts's own header comment), so this
 * is a source-contract proxy, same as every other component test here,
 * plus a real computed-style E2E proof (test/e2e/invoices.spec.ts).
 */

const source = readFileSync("src/components/invoices/invoice-lifecycle-controls.tsx", "utf-8");

// Matches a genuine Tailwind color utility (bg-black, text-gray-900,
// text-red-600, ...) — excludes non-color text-* utilities (text-sm,
// text-center, ...).
const COLOR_UTILITY_PATTERN = /^(bg|text)-(black|white|transparent|current|inherit|[a-z]+-\d{2,3})$/;

function colorUtilitiesInClassName(classNameValue: string | undefined): string[] {
  return (classNameValue ?? "").split(/\s+/).filter((cls) => COLOR_UTILITY_PATTERN.test(cls));
}

describe("InvoiceLifecycleControls — Button variant contract", () => {
  it("no <Button ...> opening tag in this file carries a raw bg-*/text-* override className", () => {
    // Non-greedy [\s\S]*?> alone would truncate at the first ">" met,
    // which is the one inside each button's own onClick={() => ...} arrow
    // function — matching "=>" as a unit first avoids that false stop.
    const buttonTags = source.match(/<Button\b(?:=>|[^>])*>/g) ?? [];
    expect(buttonTags.length).toBeGreaterThan(0);
    for (const tag of buttonTags) {
      const classNameMatch = tag.match(/className="([^"]*)"/);
      expect(colorUtilitiesInClassName(classNameMatch?.[1])).toEqual([]);
    }
  });

  it('every status-transition Button uses variant="secondary"', () => {
    const transitionButtonMatch = source.match(/\{targets\.map[\s\S]*?<Button\b(?:=>|[^>])*>/);
    expect(transitionButtonMatch).not.toBeNull();
    expect(transitionButtonMatch![0]).toContain('variant="secondary"');
  });

  it('the Cancel invoice Button uses the dedicated variant="dangerOutline", never a raw text-red-600 override', () => {
    const cancelButtonMatch = source.match(/<Button\b(?:=>|[^>])*>\s*Cancel invoice/);
    expect(cancelButtonMatch).not.toBeNull();
    expect(cancelButtonMatch![0]).toContain('variant="dangerOutline"');
  });

  it("every transition label and the Cancel invoice label are non-empty literals, never blank", () => {
    expect(source).toMatch(/\{TRANSITION_LABELS\[`\$\{status\}:\$\{target\}`\] \?\? target\}/);
    expect(source).toMatch(/>\s*Cancel invoice\s*</);
    // TRANSITION_LABELS itself lives in this file's own module scope —
    // every value must be a non-empty string literal (the `?? target`
    // fallback above already guarantees a non-empty label even for an
    // untranslated transition, since `target` is itself a non-empty
    // InvoiceStatusValue).
    const labelValues = [...source.matchAll(/"[A-Z]+:[A-Z]+":\s*"([^"]*)"/g)].map((m) => m[1]);
    expect(labelValues.length).toBeGreaterThan(0);
    for (const label of labelValues) {
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("pending/loading state never changes which Button element or variant is rendered — disabled/loading only toggle props, not the JSX branch", () => {
    // Both the transition buttons and Cancel button pass disabled={pending}
    // unconditionally (never a ternary that swaps in a differently-styled
    // element while pending) — so the variant contract proven above holds
    // for the pending state too, without needing a timing-dependent E2E
    // capture of an in-flight request.
    expect(source).toContain("disabled={pending}");
    expect(source.match(/disabled=\{pending\}/g)?.length).toBe(2);
  });
});
