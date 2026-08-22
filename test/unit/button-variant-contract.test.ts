import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Correction — Invoice System Slice 4 post-deploy fix. A production defect
 * (reproduced directly: real computed styles showed color:rgb(255,255,255)
 * on backgroundColor:rgb(255,255,255) — genuinely invisible button text)
 * traced to Button's own base classes ("bg-black ... text-white") and a
 * caller-appended override className ("bg-white text-gray-900 ...")
 * sharing equal CSS specificity — which one wins a same-specificity
 * conflict is decided by the compiled stylesheet's own utility order (a
 * Tailwind content-scan/build-time detail), never by the className
 * string's own left-to-right order. `variant` replaces that fragile
 * pattern with a set of mutually exclusive class strings — exactly one is
 * ever rendered per element — that can never combine to conflict at all.
 * A third variant (dangerOutline) was added in the consistency-pass
 * follow-up to close the same latent risk on InvoiceLifecycleControls'
 * Cancel invoice button, which used a distinct text-red-600 override.
 *
 * No DOM/component-rendering harness exists in this repo (see
 * invoice-issue-controls-contract.test.ts's own header comment) — this is
 * therefore a source-contract proxy, same as every other component test
 * here, plus a real computed-style E2E proof (test/e2e/invoices.spec.ts).
 */

const source = readFileSync("src/components/ui/button.tsx", "utf8");

const ALL_VARIANTS = ["primary", "secondary", "dangerOutline"] as const;
type Variant = (typeof ALL_VARIANTS)[number];

function extractClassValue(variant: Variant): string {
  const match = source.match(new RegExp(`${variant}:\\s*"([^"]*)"`));
  expect(match).not.toBeNull();
  return match![1];
}

// Matches a genuine Tailwind color utility (bg-black, text-white,
// bg-gray-900, text-red-500, ...) — deliberately excludes non-color
// text-* utilities that share the same prefix (text-sm, text-center,
// text-left, ...), which are sizing/alignment, not color, and must never
// be flagged as a same-property conflict.
const COLOR_UTILITY_PATTERN = /^(bg|text)-(black|white|transparent|current|inherit|[a-z]+-\d{2,3})$/;

function tailwindColorUtilities(classString: string): string[] {
  return classString.split(/\s+/).filter((cls) => COLOR_UTILITY_PATTERN.test(cls));
}

describe("Button — variant classes never overlap on the same color utility (contract)", () => {
  it("every variant exists as a distinct, non-empty class string", () => {
    for (const variant of ALL_VARIANTS) {
      expect(extractClassValue(variant).length).toBeGreaterThan(0);
    }
  });

  it("no variant's own class string is itself internally self-conflicting (at most one bg-* and one text-* utility each, and never the identical utility for both)", () => {
    // Two DIFFERENT variants sharing a bg-* or text-* utility (e.g.
    // secondary and dangerOutline both using bg-white) is fine and
    // expected — variant is a single mutually-exclusive selection, so two
    // variants' classes are never both applied to one element at once.
    // The real invariant carried over from the original bug is narrower:
    // within ONE variant's own class string, its background and
    // foreground utilities must never be the same color (that is what
    // "invisible button text" actually means), and neither utility may
    // appear more than once (which would itself be ambiguous).
    for (const variant of ALL_VARIANTS) {
      const colors = tailwindColorUtilities(extractClassValue(variant));
      const bg = colors.filter((c) => c.startsWith("bg-"));
      const text = colors.filter((c) => c.startsWith("text-"));
      expect(bg.length).toBeLessThanOrEqual(1);
      expect(text.length).toBeLessThanOrEqual(1);
      if (bg.length === 1 && text.length === 1) {
        expect(bg[0].replace(/^bg-/, "")).not.toBe(text[0].replace(/^text-/, ""));
      }
    }
  });

  it("the default variant is primary, so every existing caller that never passed `variant` renders unchanged", () => {
    expect(source).toMatch(/variant\s*=\s*"primary"/);
  });

  it("the rendered className applies the resolved variant classes, never a hardcoded color utility outside VARIANT_CLASSES", () => {
    const renderedTemplate = source.match(/className=\{`([^`]*)`\}/);
    expect(renderedTemplate).not.toBeNull();
    const literalColorUtilities = tailwindColorUtilities(renderedTemplate![1]);
    expect(literalColorUtilities).toEqual([]);
  });
});
