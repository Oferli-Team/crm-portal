import "server-only";
import path from "node:path";
import { Font } from "@react-pdf/renderer";

/**
 * Invoice System Official Slice 3, sub-PR 3a — server-only font
 * registration for the immutable invoice PDF renderer.
 *
 * Noto Sans (Regular + Bold), SIL Open Font License 1.1, sourced from the
 * Noto Project's own authoritative release repository
 * (github.com/notofonts/notofonts.github.io), Latin+Greek+Cyrillic build
 * variant, pinned to commit 10f363db6caac1f35c45d645901ba2fb76b6595e —
 * verified end-to-end in a real, disposable, production `next build` +
 * `next start` proof (including an isolated-deployment run with the
 * original source tree deleted) before being added here. Default
 * fonts (Helvetica/Times/Courier) do not cover Cyrillic/Greek glyphs.
 *
 * DEPLOYMENT-TRACING CONSTRAINT: the font paths below MUST remain literal
 * string arguments to `path.join(process.cwd(), "...")`, exactly as
 * written — this is what let Next.js's own `@vercel/nft` output-file
 * tracer correctly resolve and copy both TTFs into a traced/standalone
 * deployment bundle in the verified proof. Changing this to a
 * runtime-computed/variable path (e.g. built from an env var or a
 * template literal with an interpolated segment) is NOT covered by that
 * proof and would require re-verifying deployment-artifact completeness
 * (inspecting the relevant Route Handler's `.nft.json`) before shipping.
 *
 * No URL is ever passed to `Font.register()` here, and no `fetch` of any
 * kind occurs in this module — both font files are read from the local,
 * already-traced filesystem path only.
 */

const REGULAR_FONT_PATH = path.join(process.cwd(), "src/lib/invoices/pdf/fonts/NotoSans-Regular.ttf");
const BOLD_FONT_PATH = path.join(process.cwd(), "src/lib/invoices/pdf/fonts/NotoSans-Bold.ttf");

export const INVOICE_PDF_FONT_FAMILY = "Noto Sans";

let registered = false;

/**
 * Idempotent by construction — calling this more than once (repeated
 * renders within one process, repeated test imports, HMR in dev) performs
 * the actual `Font.register()` call at most once per process, since a
 * duplicate registration is unnecessary work, not merely harmless.
 */
export function registerInvoicePdfFonts(): void {
  if (registered) return;

  Font.register({
    family: INVOICE_PDF_FONT_FAMILY,
    fonts: [
      { src: REGULAR_FONT_PATH, fontWeight: "normal" },
      { src: BOLD_FONT_PATH, fontWeight: "bold" },
    ],
  });

  registered = true;
}
