export type AuthActionState = {
  error: string | null;
  message?: string | null;
};

export type ClientFormState = {
  error: string | null;
  fieldErrors?: Partial<
    Record<
      | "name"
      | "email"
      | "company"
      | "phone"
      | "status"
      | "billingLegalName"
      | "taxId"
      | "streetAddress"
      | "city"
      | "state"
      | "postalCode"
      | "country",
      string
    >
  >;
};

export type ProjectFormState = {
  error: string | null;
  fieldErrors?: Partial<
    Record<"name" | "clientId" | "status" | "startDate" | "endDate", string>
  >;
};

export type TaskFormState = {
  error: string | null;
  fieldErrors?: Partial<
    Record<"title" | "projectId" | "status" | "priority" | "dueDate", string>
  >;
};

// Invoice System Slice 2b (docs/invoicing-architecture.md §5/§14 Slice 2).
// "status" is deliberately absent — it is never a submitted create/edit
// form field (DRAFT-only creation; a dedicated lifecycle action owns
// status for existing non-DRAFT invoices, see status-actions.ts).
export type InvoiceScalarFieldKey =
  | "invoiceNumber"
  | "projectId"
  | "mode"
  | "amount"
  | "currency"
  | "issueDate"
  | "dueDate"
  | "notes"
  | "internalNotes"
  | "discountType"
  | "discountValue"
  | "taxRatePercent"
  | "taxLabel"
  | "lineItems";

export type InvoiceLineItemFieldKey = "description" | "quantity" | "unitPrice";

export type InvoiceFormState = {
  error: string | null;
  fieldErrors?: Partial<Record<InvoiceScalarFieldKey, string>>;
  /** Keyed by the submitted array index — matches the row order the client rendered. */
  lineItemErrors?: Record<number, Partial<Record<InvoiceLineItemFieldKey, string>>>;
};

export type InvitationFormState = {
  error: string | null;
  fieldErrors?: Partial<Record<"email" | "role", string>>;
  message?: string | null;
  /** Set on success so the UI can render a copyable invite link. */
  token?: string;
  /**
   * True when the Invitation was created/updated successfully but the
   * email itself could not be delivered — `message` still describes what
   * happened, this just tells the UI to render it as a warning instead of
   * a success (Copy link remains the fallback either way).
   */
  emailFailed?: boolean;
};

export type InviteAcceptState = {
  error: string | null;
};

export type PortalInvitationFormState = {
  error: string | null;
  fieldErrors?: Partial<Record<"email", string>>;
  message?: string | null;
  /** Set on success so the UI can render a copyable invite link. */
  token?: string;
  /**
   * True when the ClientInvitation was created/updated successfully but the
   * email itself could not be delivered — `message` still describes what
   * happened, this just tells the UI to render it as a warning instead of
   * a success (Copy link remains the fallback either way).
   */
  emailFailed?: boolean;
};

export type MembershipActionState = {
  error: string | null;
};

export type AttachmentUploadState = {
  error: string | null;
};

// Sale-Ready Phase A.1 (Business Identity), PR4 — same shape as
// AttachmentUploadState, kept as its own type rather than reused: a logo
// upload is not an Attachment (see logo-mutations.ts), and the two are
// free to diverge independently as either evolves.
export type LogoUploadState = {
  error: string | null;
};

export type CommentActionState = {
  error: string | null;
};

export type CompanyProfileFormState = {
  error: string | null;
  fieldErrors?: Partial<
    Record<
      | "legalName"
      | "displayName"
      | "country"
      | "currency"
      | "timezone"
      // Sale-Ready Phase A.1 (Business Identity), PR2 — all nine below are
      // optional fields; a fieldError only ever appears for one of them
      // when a *non-empty* value fails its own format check, never for
      // being empty (they're nullable, not required).
      | "supportEmail"
      | "website"
      | "phone"
      | "taxId"
      | "brandColor"
      | "streetAddress"
      | "city"
      | "state"
      | "postalCode",
      string
    >
  >;
  message?: string | null;
};

export type PaymentDetailsFormState = {
  error: string | null;
  fieldErrors?: Partial<Record<"bankName" | "accountHolder" | "accountNumber" | "swiftBic" | "paymentInstructions", string>>;
  message?: string | null;
};

export type DomainSettingsFormState = {
  error: string | null;
  fieldErrors?: Partial<Record<"customDomain", string>>;
  message?: string | null;
};
