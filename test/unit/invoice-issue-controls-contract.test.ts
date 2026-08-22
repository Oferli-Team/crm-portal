import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source-contract coverage for InvoiceIssueControls's own client-side
 * rejection handling — this repo has no DOM/component-interaction test
 * harness (no `@testing-library/react`/jsdom setup anywhere in this
 * codebase; the one existing `.test.tsx` file, invoice-pdf-document.test.tsx,
 * exercises @react-pdf/renderer's own document tree, not a DOM component),
 * so a genuine "click the button, make the Server Action reject, assert the
 * toast" test is not currently expressible. This is the documented
 * limitation: the guarantee below is verified at the source level instead
 * — a narrow, stable proxy for "the client call site cannot let a rejected
 * Server Action promise escape unhandled" — until a component-test harness
 * exists in this repo.
 */

const source = readFileSync("src/components/invoices/invoice-issue-controls.tsx", "utf-8");

describe("InvoiceIssueControls — client Server Action rejection handling (source contract)", () => {
  it("wraps the issueInvoiceAction() call in try/catch", () => {
    const callIndex = source.indexOf("await issueInvoiceAction(");
    expect(callIndex).toBeGreaterThan(-1);
    const precedingTry = source.lastIndexOf("try {", callIndex);
    expect(precedingTry).toBeGreaterThan(-1);
    // No other statement sits between the try block's own opening and the
    // issueInvoiceAction() call other than the result-variable declaration.
    const between = source.slice(precedingTry, callIndex);
    expect(between).not.toContain("await ");
  });

  it("the catch block never references the caught error (no thrown detail is ever surfaced to the UI)", () => {
    const catchMatch = source.match(/\}\s*catch\s*\{([\s\S]*?)\n\s{6}\}/);
    expect(catchMatch).not.toBeNull();
    const catchBody = catchMatch![1];
    // A bare `catch {` (no bound identifier at all) is itself the
    // strongest form of this guarantee — there is no name to accidentally
    // reference.
    expect(source).toMatch(/\}\s*catch\s*\{/);
    expect(catchBody).not.toMatch(/\.message\b/);
  });

  it("the catch block shows the same generic safe failure toast used elsewhere in this component, never a distinct message", () => {
    const catchMatch = source.match(/\}\s*catch\s*\{([\s\S]*?)\n\s{6}\}/);
    const catchBody = catchMatch![1];
    expect(catchBody).toContain('showToast("Could not issue this invoice — try again.", "error")');
  });

  it("the catch block never calls router.refresh() or re-invokes issueInvoiceAction() — no implicit retry", () => {
    const catchMatch = source.match(/\}\s*catch\s*\{([\s\S]*?)\n\s{6}\}/);
    const catchBody = catchMatch![1];
    expect(catchBody).not.toContain("router.refresh()");
    expect(catchBody).not.toContain("issueInvoiceAction(");
  });

  it("issueInvoiceAction is called exactly once per runIssue() invocation — the catch path returns rather than looping", () => {
    const occurrences = source.match(/issueInvoiceAction\(/g) ?? [];
    // Exactly one call site (the import statement itself has no trailing
    // parenthesis) — never a second, implicit retry call.
    expect(occurrences.length).toBe(1);
  });

  // Correction — Invoice System Slice 4 post-deploy fix. The button's own
  // label ("Issue invoice") uses the shared Button component's `variant`
  // prop, never a raw color-utility className appended alongside the
  // component's own hardcoded base classes — that exact pattern produced
  // a reproduced production defect (invisible white-on-white button
  // text). See button-variant-contract.test.ts for the shared component's
  // own contract.
  it("the Issue invoice Button uses variant=\"secondary\", never a raw bg-*/text-* override className", () => {
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

  it("the button label \"Issue invoice\" is a literal, non-empty JSX text child", () => {
    expect(source).toMatch(/>\s*Issue invoice\s*</);
  });
});
