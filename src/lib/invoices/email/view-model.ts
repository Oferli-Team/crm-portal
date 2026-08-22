import { formatInvoiceCurrencyAmount, type CurrencyAmountInput } from "@/lib/invoices/currencies";
import { formatDateOnlyForDisplay } from "@/lib/invoices/date-only";

/**
 * Invoice System Slice 4, PR 4a — unwired foundation. Nothing in
 * production imports this yet; it exists so PR 4b's own send-invoice-
 * email service has a pure, already-tested rendering step to call.
 *
 * Deliberately pure: no Prisma client, no environment access, no Storage,
 * no Resend, no auth, no database, no route/request import of any kind —
 * every value this module renders comes from its own explicit,
 * already-validated `InvoiceEmailViewModelInput`, never re-derived here.
 * `CurrencyAmountInput` (imported below from
 * src/lib/invoices/currencies.ts) is itself backed by
 * `@/generated/prisma/browser`'s own browser-safe `Decimal` — never
 * `@/generated/prisma/client` — so this stays safe for a pure/potentially
 * client-adjacent boundary; see that module's own header comment.
 *
 * This is why it deliberately does NOT call
 * buildEmailLegalFooterHtml()/buildEmailLegalFooterText()
 * (src/lib/email/legal-footer.ts) the way every other transactional email
 * template in this app does: that module reads
 * `process.env.APP_BASE_URL`/`VERCEL_URL` internally, which would make
 * this one impure by association. PR 4b's own send service — not this
 * module — is the right, impure layer to compose this content with that
 * shared footer before handing it to sendEmailViaResend().
 *
 * Also deliberately has no attachment-filename field: that's
 * `buildInvoicePdfDownloadFilename()` (src/lib/invoices/pdf/storage.ts),
 * which PR 4b's own caller can call directly from `invoiceNumber` — adding
 * an equivalent field here would either duplicate that sanitization logic
 * or import across the pdf/email module boundary this file is kept
 * decoupled from.
 */

export type InvoiceEmailViewModelInput = {
  invoiceNumber: string;
  /** Frozen InvoiceRecipientSnapshotV1.billingName — never a live/mutable Client name. */
  recipientDisplayName: string;
  /** Frozen InvoiceIssuerSnapshotV1.legalName — never a live/mutable Organization name. */
  issuerDisplayName: string;
  totalAmount: CurrencyAmountInput;
  currency: string;
  /** A date-only value, per parseDateOnly()'s own UTC-midnight contract — never a real timestamp. */
  dueDate: Date | null;
  /**
   * Already resolved and validated by the caller (e.g. via
   * resolveTrustedInvoiceEmailOrigin() plus the invoice's own id/portal
   * route) — this module never builds, parses, or validates a URL itself,
   * and never embeds an access token in it. Omit entirely (or pass null)
   * when no trusted origin exists; the rendered email simply has no
   * "View invoice" link in that case, and sending is never blocked on it.
   */
  portalInvoiceUrl?: string | null;
  locale?: string;
};

export type InvoiceEmailContent = {
  subject: string;
  html: string;
  text: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTotal(input: InvoiceEmailViewModelInput): string {
  // formatInvoiceCurrencyAmount() only returns null for a currency/amount
  // this app's own invoice-creation validation should never have allowed
  // through in the first place — this fallback exists so a pure rendering
  // function never throws, not because null is an expected case.
  return formatInvoiceCurrencyAmount(input.totalAmount, input.currency, input.locale) ?? `${input.currency} ${String(input.totalAmount)}`;
}

function renderHtml(input: InvoiceEmailViewModelInput, formattedTotal: string, formattedDueDate: string | null): string {
  const invoiceNumber = escapeHtml(input.invoiceNumber);
  const recipientDisplayName = escapeHtml(input.recipientDisplayName);
  const issuerDisplayName = escapeHtml(input.issuerDisplayName);
  const total = escapeHtml(formattedTotal);
  const dueDateClause = formattedDueDate ? `, due ${escapeHtml(formattedDueDate)}` : "";

  const portalLinkHtml = input.portalInvoiceUrl
    ? `<p style="margin: 24px 0;">
      <a href="${escapeHtml(input.portalInvoiceUrl)}" style="display: inline-block; background: #000000; color: #ffffff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600;">
        View invoice
      </a>
    </p>`
    : "";

  return `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #111827; line-height: 1.5; margin: 0; padding: 24px;">
    <p>Dear ${recipientDisplayName},</p>
    <p>${issuerDisplayName} has issued invoice <strong>${invoiceNumber}</strong> for <strong>${total}</strong>${dueDateClause}. The invoice is attached to this email as a PDF.</p>
    ${portalLinkHtml}
    <p style="color: #6b7280; font-size: 12px; margin-top: 32px;">
      If you have any questions about this invoice, please contact ${issuerDisplayName} directly.
    </p>
  </body>
</html>`;
}

function renderText(input: InvoiceEmailViewModelInput, formattedTotal: string, formattedDueDate: string | null): string {
  const lines = [
    `Dear ${input.recipientDisplayName},`,
    "",
    `${input.issuerDisplayName} has issued invoice ${input.invoiceNumber} for ${formattedTotal}${formattedDueDate ? `, due ${formattedDueDate}` : ""}. The invoice is attached to this email as a PDF.`,
  ];

  if (input.portalInvoiceUrl) {
    lines.push("", `View invoice: ${input.portalInvoiceUrl}`);
  }

  lines.push("", `If you have any questions about this invoice, please contact ${input.issuerDisplayName} directly.`);

  return lines.join("\n");
}

/**
 * Renders the subject/HTML/plain-text content for an Invoice email — pure
 * and deterministic for the same input. Every value interpolated into
 * `html` is HTML-escaped (including inside the `href` attribute, where a
 * quote character could otherwise break out of it); `text` is left as
 * plain text, never substituting HTML entities for the equivalent
 * character. Never claims the email was "delivered" — only that the
 * invoice has been issued and is attached, since this module has no way
 * to know whether the send that follows actually succeeds.
 */
export function buildInvoiceEmailContent(input: InvoiceEmailViewModelInput): InvoiceEmailContent {
  const formattedTotal = formatTotal(input);
  const formattedDueDate = input.dueDate ? formatDateOnlyForDisplay(input.dueDate, input.locale) : null;

  return {
    subject: `Invoice ${input.invoiceNumber} from ${input.issuerDisplayName}`,
    html: renderHtml(input, formattedTotal, formattedDueDate),
    text: renderText(input, formattedTotal, formattedDueDate),
  };
}
